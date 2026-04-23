# RAG Document QA System

## What It Does
Upload PDF/TXT documents, then ask questions. The system finds relevant information and answers using AI.

## Tech Stack
- Firebase Auth (Google + Email login)
- Cloud Functions (Serverless backend)
- Pinecone (Vector database)
- OpenAI GPT-3.5 (Answer generation)

## Setup Instructions

### 1. Create Firebase Project
- Go to console.firebase.google.com
- Create new project "rag-document-qa"
- Enable Authentication (Email/Password + Google)
- Create Firestore Database
- Enable Storage

### 2. Create Pinecone Account
- Sign up at pinecone.io
- Create index "documents" (dimensions: 384, metric: cosine)

### 3. Get OpenAI Key
- platform.openai.com/api-keys
- Create new secret key

### 4. Deploy
```bash
# Install dependencies
cd functions
npm install
pip install -r requirements.txt

# Set config
firebase functions:config:set openai.key="your-key"
firebase functions:config:set pinecone.key="your-key"

# Deploy
firebase deploy