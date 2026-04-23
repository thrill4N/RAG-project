// Firebase Configuration - REPLACE WITH YOURS
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
const functions = firebase.functions();

// App state
let currentUser = null;
let currentConversationId = null;

// DOM Elements
const appDiv = document.getElementById('app');

// Render app
function render() {
    if (!currentUser) {
        renderLogin();
    } else {
        renderMainApp();
    }
}

// Login screen
function renderLogin() {
    appDiv.innerHTML = `
        <div class="login-container">
            <div class="login-card">
                <h1>📄 RAG Document QA</h1>
                <p class="subtitle">Ask questions about your documents</p>
                
                <button class="google-btn" id="googleBtn">
                    🚀 Sign in with Google
                </button>
                
                <div class="divider">OR</div>
                
                <div class="auth-form">
                    <input type="email" id="loginEmail" placeholder="Email">
                    <input type="password" id="loginPassword" placeholder="Password">
                    <button id="loginBtn">Sign In</button>
                </div>
                
                <div class="switch-mode" id="switchMode">
                    Don't have an account? Sign up
                </div>
            </div>
        </div>
    `;
    
    let isLogin = true;
    
    document.getElementById('googleBtn').onclick = async () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        await auth.signInWithPopup(provider);
    };
    
    document.getElementById('loginBtn').onclick = async () => {
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        if (isLogin) {
            await auth.signInWithEmailAndPassword(email, password);
        } else {
            await auth.createUserWithEmailAndPassword(email, password);
        }
    };
    
    document.getElementById('switchMode').onclick = () => {
        isLogin = !isLogin;
        const btn = document.getElementById('loginBtn');
        const switchText = document.getElementById('switchMode');
        
        if (isLogin) {
            btn.textContent = 'Sign In';
            switchText.textContent = "Don't have an account? Sign up";
        } else {
            btn.textContent = 'Sign Up';
            switchText.textContent = 'Already have an account? Sign in';
        }
    };
}

// Main app
async function renderMainApp() {
    appDiv.innerHTML = `
        <div class="app-container">
            <div class="header">
                <h1>📄 RAG Document QA System</h1>
                <div class="user-info">
                    <span>${currentUser.email}</span>
                    <button class="logout-btn" id="logoutBtn">Logout</button>
                </div>
            </div>
            
            <div class="main-content">
                <div class="documents-panel">
                    <h2>📁 My Documents</h2>
                    <button class="upload-btn" id="uploadBtn">+ Upload Document</button>
                    <input type="file" id="fileInput" accept=".pdf,.txt" style="display:none">
                    <div id="documentList" class="document-list">
                        <div class="empty-docs">Loading documents...</div>
                    </div>
                </div>
                
                <div class="chat-panel">
                    <div id="messagesArea" class="messages-area">
                        <div class="empty-docs">Ask a question about your documents</div>
                    </div>
                    <div class="input-area">
                        <input type="text" id="questionInput" placeholder="Ask a question...">
                        <button id="sendBtn">Send</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Load documents
    await loadDocuments();
    
    // Load conversations
    await loadConversations();
    
    // Upload handler
    document.getElementById('uploadBtn').onclick = () => {
        document.getElementById('fileInput').click();
    };
    
    document.getElementById('fileInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const uploadBtn = document.getElementById('uploadBtn');
        uploadBtn.textContent = 'Uploading...';
        uploadBtn.disabled = true;
        
        const storageRef = storage.ref(`${currentUser.uid}/${file.name}`);
        await storageRef.put(file);
        
        uploadBtn.textContent = '+ Upload Document';
        uploadBtn.disabled = false;
        
        await loadDocuments();
    };
    
    // Send message handler
    document.getElementById('sendBtn').onclick = sendMessage;
    document.getElementById('questionInput').onkeypress = (e) => {
        if (e.key === 'Enter') sendMessage();
    };
    
    // Logout
    document.getElementById('logoutBtn').onclick = async () => {
        await auth.signOut();
    };
}

async function loadDocuments() {
    const listDocs = functions.httpsCallable('listDocuments');
    const result = await listDocs();
    const docs = result.data;
    
    const container = document.getElementById('documentList');
    
    if (docs.length === 0) {
        container.innerHTML = '<div class="empty-docs">No documents yet. Upload your first PDF or text file.</div>';
        return;
    }
    
    container.innerHTML = docs.map(doc => `
        <div class="document-item">
            <div class="document-name">📄 ${doc.fileName}</div>
            <div class="document-status status-${doc.status}">
                ${doc.status === 'ready' ? '✅ Ready' : '⏳ Processing...'}
                ${doc.chunkCount ? ` • ${doc.chunkCount} chunks` : ''}
            </div>
            <button class="delete-doc" data-id="${doc.id}" data-name="${doc.fileName}">Delete</button>
        </div>
    `).join('');
    
    // Delete handlers
    document.querySelectorAll('.delete-doc').forEach(btn => {
        btn.onclick = async () => {
            const deleteDoc = functions.httpsCallable('deleteDocument');
            await deleteDoc({ documentId: btn.dataset.id, fileName: btn.dataset.name });
            await loadDocuments();
        };
    });
}

async function loadConversations() {
    const conversations = await db.collection('conversations')
        .where('userId', '==', currentUser.uid)
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get();
    
    if (!conversations.empty) {
        currentConversationId = conversations.docs[0].id;
        await loadMessages(currentConversationId);
    }
}

async function loadMessages(conversationId) {
    const messagesSnapshot = await db.collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('timestamp', 'asc')
        .get();
    
    const messagesArea = document.getElementById('messagesArea');
    
    if (messagesSnapshot.empty) {
        messagesArea.innerHTML = '<div class="empty-docs">Ask a question about your documents</div>';
        return;
    }
    
    messagesArea.innerHTML = messagesSnapshot.docs.map(doc => {
        const msg = doc.data();
        if (msg.role === 'user') {
            return `
                <div class="message message-user">
                    <div class="message-bubble">${escapeHtml(msg.content)}</div>
                </div>
            `;
        } else {
            return `
                <div class="message message-assistant">
                    <div class="message-bubble">${escapeHtml(msg.content)}</div>
                    ${msg.citations ? `
                        <div class="citations">
                            📚 Sources: ${msg.citations.map(c => c.document).join(', ')}
                        </div>
                    ` : ''}
                </div>
            `;
        }
    }).join('');
    
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

async function sendMessage() {
    const input = document.getElementById('questionInput');
    const question = input.value.trim();
    if (!question) return;
    
    input.value = '';
    
    const messagesArea = document.getElementById('messagesArea');
    
    // Add user message to UI
    messagesArea.innerHTML += `
        <div class="message message-user">
            <div class="message-bubble">${escapeHtml(question)}</div>
        </div>
    `;
    
    // Add thinking indicator
    const thinkingId = 'thinking-' + Date.now();
    messagesArea.innerHTML += `
        <div id="${thinkingId}" class="message message-assistant">
            <div class="message-bubble thinking">🤔 Thinking...</div>
        </div>
    `;
    messagesArea.scrollTop = messagesArea.scrollHeight;
    
    // Call RAG function
    const ragChat = functions.httpsCallable('ragChat');
    const result = await ragChat({ question, conversationId: currentConversationId });
    
    // Remove thinking indicator
    document.getElementById(thinkingId)?.remove();
    
    // Add assistant response
    messagesArea.innerHTML += `
        <div class="message message-assistant">
            <div class="message-bubble">${escapeHtml(result.data.answer)}</div>
            ${result.data.citations.length > 0 ? `
                <div class="citations">
                    📚 Sources: ${result.data.citations.map(c => c.document).join(', ')}
                </div>
            ` : ''}
        </div>
    `;
    
    currentConversationId = result.data.conversationId;
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Auth state listener
auth.onAuthStateChanged(user => {
    currentUser = user;
    render();
});