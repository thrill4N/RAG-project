/**
 * RAG Document QA System - Firebase Cloud Functions
 * Complete working version
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

// Initialize Pinecone
const pinecone = new Pinecone({
  apiKey: functions.config().pinecone.key,
});
const index = pinecone.index('documents');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: functions.config().openai.key,
});

/**
 * Generate embeddings using Python sentence-transformers
 */
async function generateEmbedding(text) {
  return new Promise((resolve, reject) => {
    const pythonScript = `
import sys
import json
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('all-MiniLM-L6-v2')
text = sys.argv[1]
embedding = model.encode(text).tolist()
print(json.dumps(embedding))
`;
    
    const pythonProcess = spawn('python', ['-c', pythonScript, text]);
    
    let output = '';
    let error = '';
    
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python error: ${error}`));
      } else {
        try {
          const embedding = JSON.parse(output);
          resolve(embedding);
        } catch (e) {
          reject(new Error(`Failed to parse embedding: ${e.message}`));
        }
      }
    });
  });
}

/**
 * Extract text from PDF using Python
 */
async function extractPDFText(buffer) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `temp_${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, buffer);
    
    const pythonScript = `
import sys
import pypdf

pdf_path = sys.argv[1]
text = ''
with open(pdf_path, 'rb') as f:
    reader = pypdf.PdfReader(f)
    for page in reader.pages:
        text += page.extract_text() + '\\n'
print(text)
`;
    
    const pythonProcess = spawn('python', ['-c', pythonScript, tempFile]);
    
    let output = '';
    let error = '';
    
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      fs.unlinkSync(tempFile);
      if (code !== 0) {
        reject(new Error(`PDF extraction error: ${error}`));
      } else {
        resolve(output);
      }
    });
  });
}

/**
 * Chunk text into overlapping segments
 */
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/);
  const chunks = [];
  
  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 50) {
      chunks.push(chunk);
    }
  }
  
  return chunks;
}

/**
 * CLOUD FUNCTION 1: Process uploaded document
 */
exports.processDocument = functions.storage
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    const parts = filePath.split('/');
    const userId = parts[0];
    const fileName = parts.slice(1).join('/');
    
    console.log(`📄 Processing: ${fileName} for user ${userId}`);
    
    try {
      // Download file
      const bucket = storage.bucket(object.bucket);
      const file = bucket.file(filePath);
      const [buffer] = await file.download();
      
      // Extract text
      let text = '';
      if (fileName.toLowerCase().endsWith('.pdf')) {
        text = await extractPDFText(buffer);
      } else if (fileName.toLowerCase().endsWith('.txt')) {
        text = buffer.toString('utf-8');
      } else {
        throw new Error(`Unsupported file type: ${fileName}`);
      }
      
      if (!text || text.trim().length === 0) {
        throw new Error('No text extracted from document');
      }
      
      // Chunk text
      const chunks = chunkText(text);
      console.log(`📦 Created ${chunks.length} chunks`);
      
      // Generate embeddings and store in Pinecone
      const vectors = [];
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await generateEmbedding(chunks[i]);
        vectors.push({
          id: `${userId}_${fileName.replace(/[^a-zA-Z0-9]/g, '_')}_${i}`,
          values: embedding,
          metadata: {
            userId: userId,
            document: fileName,
            chunkIndex: i,
            text: chunks[i].substring(0, 500)
          }
        });
        
        // Rate limiting
        if (i % 10 === 0 && i > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Batch upsert to Pinecone
      const batchSize = 100;
      for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        await index.upsert(batch);
      }
      
      // Store metadata in Firestore
      await db.collection('documents').doc(`${userId}_${fileName}`).set({
        userId: userId,
        fileName: fileName,
        chunkCount: chunks.length,
        status: 'ready',
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        storagePath: filePath
      });
      
      console.log(`✅ Processed: ${fileName}`);
      return { success: true, chunks: chunks.length };
      
    } catch (error) {
      console.error(`❌ Error processing ${fileName}:`, error);
      await db.collection('documents').doc(`${userId}_${fileName}`).set({
        status: 'failed',
        error: error.message
      }, { merge: true });
      throw error;
    }
  });

/**
 * CLOUD FUNCTION 2: RAG Chat
 */
exports.ragChat = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  
  const userId = context.auth.uid;
  const { question, conversationId } = data;
  
  if (!question || question.trim().length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Question is required');
  }
  
  console.log(`💬 Question from ${userId}: ${question.substring(0, 100)}...`);
  
  try {
    // Generate embedding for question
    const questionEmbedding = await generateEmbedding(question);
    
    // Search Pinecone
    const searchResults = await index.query({
      vector: questionEmbedding,
      topK: 5,
      includeMetadata: true,
      filter: { userId: userId }
    });
    
    const relevantChunks = searchResults.matches.map(match => ({
      text: match.metadata.text,
      document: match.metadata.document,
      score: match.score
    }));
    
    // Build context
    const context = relevantChunks.length > 0 
      ? relevantChunks.map((chunk, i) => 
          `[Source ${i + 1} from ${chunk.document}]:\n${chunk.text}`
        ).join('\n\n---\n\n')
      : 'No relevant documents found.';
    
    // Build prompt
    const prompt = `You are a helpful assistant answering questions based ONLY on the provided documents.

CONTEXT FROM DOCUMENTS:
${context}

USER QUESTION: ${question}

INSTRUCTIONS:
1. Answer based ONLY on the context above
2. If the answer is not in the context, say "I cannot find this information in your uploaded documents"
3. Cite which document you're referencing
4. Be concise and helpful

ANSWER:`;
    
    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You answer questions based on provided document context." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500
    });
    
    const answer = completion.choices[0].message.content;
    const tokensUsed = completion.usage.total_tokens;
    
    // Save to Firestore
    let convId = conversationId;
    
    if (!convId) {
      const newConv = await db.collection('conversations').add({
        userId: userId,
        title: question.substring(0, 50),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      convId = newConv.id;
    }
    
    await db.collection('conversations').doc(convId)
      .collection('messages').add({
        role: 'user',
        content: question,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    
    await db.collection('conversations').doc(convId)
      .collection('messages').add({
        role: 'assistant',
        content: answer,
        citations: relevantChunks.map(c => ({ document: c.document, score: c.score })),
        tokensUsed: tokensUsed,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    
    await db.collection('conversations').doc(convId).update({
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return {
      answer: answer,
      citations: relevantChunks.map(c => ({ document: c.document, score: c.score })),
      conversationId: convId,
      tokensUsed: tokensUsed
    };
    
  } catch (error) {
    console.error('❌ RAG Chat error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * CLOUD FUNCTION 3: List user documents
 */
exports.listDocuments = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  
  const userId = context.auth.uid;
  
  const snapshot = await db.collection('documents')
    .where('userId', '==', userId)
    .orderBy('uploadedAt', 'desc')
    .get();
  
  return snapshot.docs.map(doc => ({
    id: doc.id,
    fileName: doc.data().fileName,
    status: doc.data().status,
    chunkCount: doc.data().chunkCount || 0,
    uploadedAt: doc.data().uploadedAt?.toDate?.() || null
  }));
});

/**
 * CLOUD FUNCTION 4: Delete document
 */
exports.deleteDocument = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  
  const userId = context.auth.uid;
  const { documentId, fileName } = data;
  
  // Delete from Storage
  const bucket = storage.bucket('rag-document-qa.firebasestorage.app');
  await bucket.file(`${userId}/${fileName}`).delete().catch(() => {});
  
  // Delete vectors from Pinecone
  const prefix = `${userId}_${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  await index.deleteMany({ prefix: prefix }).catch(() => {});
  
  // Delete from Firestore
  await db.collection('documents').doc(documentId).delete();
  
  return { success: true };
});