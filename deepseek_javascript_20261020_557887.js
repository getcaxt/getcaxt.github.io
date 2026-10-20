import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail, updateProfile
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, getDocs, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ============================================================
// FIREBASE INIT
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyABmNpMEzNyowq-lY_T9Mvnpj9i8UCJOy8",
  authDomain: "caxt-3c75a.firebaseapp.com",
  projectId: "caxt-3c75a",
  storageBucket: "caxt-3c75a.firebasestorage.app",
  messagingSenderId: "297599583040",
  appId: "1:297599583040:web:43d75821eea21c401430a5"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ============================================================
// STATE
// ============================================================
let currentUser = null;       // Firebase Auth user
let currentProfile = null;    // Firestore user doc { displayName, ... }
let currentConversation = null;  // { id, type, name, participants, ... }
let conversationsUnsub = null;
let messagesUnsub = null;
let profileCache = {};         // uid → { displayName }
let inboxConversations = [];

// ============================================================
// HELPERS
// ============================================================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDaySep(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function initials(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}

async function getProfile(uid) {
  if (profileCache[uid]) return profileCache[uid];
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      profileCache[uid] = snap.data();
      return profileCache[uid];
    }
  } catch (e) {}
  return { displayName: 'Unknown' };
}

// ============================================================
// AUTH FLOW
// ============================================================
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('auth-sub').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
  $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('auth-switch-text').textContent = mode === 'login' ? 'No account?' : 'Have an account?';
  $('auth-switch-btn').textContent = mode === 'login' ? 'Sign up' : 'Log in';
  $('auth-confirm-field').style.display = mode === 'signup' ? 'block' : 'none';
  $('auth-forgot').style.display = mode === 'login' ? 'block' : 'none';
  $('auth-error').textContent = '';
}

$('auth-switch-btn').onclick = () => setAuthMode(authMode === 'login' ? 'signup' : 'login');

$('auth-submit').onclick = async () => {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const errEl = $('auth-error');
  errEl.textContent = '';

  if (!email || !password) return errEl.textContent = 'Fill in both fields.';
  if (password.length < 6) return errEl.textContent = 'Password must be at least 6 characters.';

  const btn = $('auth-submit');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    if (authMode === 'login') {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      const confirm = $('auth-confirm').value;
      if (password !== confirm) throw new Error('Passwords do not match.');
      await createUserWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    const msg = {
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/user-not-found': 'No account with that email.',
      'auth/wrong-password': 'Wrong password.',
      'auth/email-already-in-use': 'That email is already registered.',
      'auth/invalid-email': 'That email looks invalid.',
      'auth/weak-password': 'Password is too weak.',
      'auth/too-many-requests': 'Too many attempts. Try again later.',
    }[e.code] || e.message;
    errEl.textContent = msg;
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Log in' : 'Sign up';
  }
};

$('auth-forgot').onclick = async () => {
  const email = $('auth-email').value.trim();
  if (!email) return $('auth-error').textContent = 'Enter your email first.';
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent.');
  } catch (e) {
    $('auth-error').textContent = e.message;
  }
};

// ============================================================
// NAME SETUP
// ============================================================
$('name-submit').onclick = async () => {
  const name = $('name-input').value.trim().toLowerCase();
  const errEl = $('name-error');
  errEl.textContent = '';

  if (!name) return errEl.textContent = 'Enter a name.';
  if (!/^[a-z0-9_]{2,20}$/.test(name)) return errEl.textContent = 'Only letters, numbers, underscores. 2–20 chars.';

  const btn = $('name-submit');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const nameRef = doc(db, 'displayNames', name);
    const nameSnap = await getDoc(nameRef);
    if (nameSnap.exists()) throw new Error('That name is taken.');

    await setDoc(nameRef, { uid: currentUser.uid });
    await setDoc(doc(db, 'users', currentUser.uid), {
      displayName: name,
      createdAt: Date.now()
    });
    await updateProfile(currentUser, { displayName: name });

    currentProfile = { displayName: name };
    showScreen('main-screen');
    startMainApp();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
};

// ============================================================
// AUTH STATE
// ============================================================
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    currentProfile = null;
    showScreen('auth-screen');
    setAuthMode('login');
    return;
  }
  // Logged in — check if profile exists
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) {
      currentProfile = snap.data();
      showScreen('main-screen');
      startMainApp();
    } else {
      showScreen('name-screen');
    }
  } catch (e) {
    console.error('Auth state check failed:', e);
    showScreen('auth-screen');
    $('auth-error').textContent = 'Failed to load profile: ' + e.message;
  }
});

// ============================================================
// MAIN APP
// ============================================================
function startMainApp() {
  if (!currentProfile) return;
  $('topbar-title').textContent = 'caxt';
  $('menu-info').innerHTML = `Signed in as <b>${esc(currentProfile.displayName)}</b>`;

  // Listen to inbox
  if (conversationsUnsub) conversationsUnsub();
  const q = query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', currentUser.uid),
    orderBy('lastMessageAt', 'desc')
  );

  conversationsUnsub = onSnapshot(q,
    snap => {
      inboxConversations = [];
      snap.forEach(d => inboxConversations.push({ id: d.id, ...d.data() }));
      renderInbox();
    },
    err => {
      console.error('Inbox error:', err);
      if (err.message && err.message.includes('index')) {
        const m = err.message.match(/https:\/\/[^\s]+/);
        toast('Index needed — check console for link', true);
        if (m) console.log('%cCREATE INDEX HERE:', 'color:#0a84ff;font-size:16px;font-weight:bold', m[0]);
      }
    }
  );
}

async function renderInbox() {
  const list = $('inbox-list');
  if (!inboxConversations.length) {
    list.innerHTML = '<div class="empty-state">No conversations yet.<br>Tap + to start one.</div>';
    return;
  }
  list.innerHTML = '';
  for (const conv of inboxConversations) {
    const isGroup = conv.type === 'group';
    let displayName, avatarClass = 'avatar';
    if (isGroup) {
      displayName = conv.name || 'Group';
      avatarClass = 'avatar group';
    } else {
      const otherUid = conv.participants.find(p => p !== currentUser.uid);
      const prof = await getProfile(otherUid);
      displayName = prof.displayName || 'Unknown';
    }

    const item = document.createElement('div');
    item.className = 'inbox-item';
    item.innerHTML = `
      <div class="${avatarClass}">${esc(initials(displayName))}</div>
      <div class="inbox-body">
        <div class="inbox-name">${esc(displayName)}${isGroup ? ' <span style="color:var(--text-dim);font-size:12px;font-weight:400">· group</span>' : ''}</div>
        <div class="inbox-preview">${esc(conv.lastMessage || 'No messages yet')}</div>
      </div>
      <div class="inbox-time">${formatTime(conv.lastMessageAt)}</div>
    `;
    item.onclick = () => openConversation(conv);
    list.appendChild(item);
  }
}

// ============================================================
// OPEN CONVERSATION
// ============================================================
async function openConversation(conv) {
  currentConversation = conv;
  showScreen('main-screen');
  $('view-inbox').classList.remove('active');
  $('view-chat').classList.add('active');

  let title;
  if (conv.type === 'group') {
    title = conv.name || 'Group';
  } else {
    const otherUid = conv.participants.find(p => p !== currentUser.uid);
    const prof = await getProfile(otherUid);
    title = prof.displayName || 'Chat';
  }
  $('chat-title').textContent = title;
  $('topbar-title').textContent = title;

  // Listen to messages
  if (messagesUnsub) messagesUnsub();
  const q = query(
    collection(db, 'conversations', conv.id, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(200)
  );

  messagesUnsub = onSnapshot(q, snap => {
    const msgs = [];
    snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
    renderMessages(msgs);
  });
}

async function renderMessages(msgs) {
  const container = $('messages');
  if (!msgs.length) {
    container.innerHTML = '<div class="empty-state" style="padding:40px 20px;">No messages yet.<br>Say hi 👋</div>';
    return;
  }
  container.innerHTML = '';
  let lastDay = '';
  const isGroup = currentConversation?.type === 'group';

  for (const m of msgs) {
    const authorProf = await getProfile(m.authorUid);
    const dayStr = new Date(m.createdAt).toDateString();
    if (dayStr !== lastDay) {
      lastDay = dayStr;
      const sep = document.createElement('div');
      sep.className = 'msg-day-sep';
      sep.textContent = formatDaySep(m.createdAt);
      container.appendChild(sep);
    }

    if (isGroup && m.authorUid !== currentUser.uid) {
      const author = document.createElement('div');
      author.className = 'msg-author';
      author.textContent = authorProf.displayName;
      container.appendChild(author);
    }

    const row = document.createElement('div');
    row.className = 'msg-row ' + (m.authorUid === currentUser.uid ? 'me' : 'them');
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = m.text;
    row.appendChild(bubble);
    container.appendChild(row);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.style.textAlign = m.authorUid === currentUser.uid ? 'right' : 'left';
    time.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    container.appendChild(time);
  }
  container.scrollTop = container.scrollHeight;
}

// ============================================================
// SEND MESSAGE
// ============================================================
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !currentConversation) return;
  input.value = '';
  const btn = $('send-btn');
  btn.disabled = true;

  try {
    await addDoc(collection(db, 'conversations', currentConversation.id, 'messages'), {
      authorUid: currentUser.uid,
      text,
      createdAt: Date.now()
    });
    await updateDoc(doc(db, 'conversations', currentConversation.id), {
      lastMessage: text.slice(0, 100),
      lastMessageAt: Date.now()
    });
  } catch (e) {
    toast('Send failed: ' + e.message, true);
    input.value = text;
  } finally {
    btn.disabled = false;
    input.focus();
  }
};

// ============================================================
// BACK BUTTON
// ============================================================
$('btn-back').onclick = () => {
  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
  currentConversation = null;
  $('view-chat').classList.remove('active');
  $('view-inbox').classList.add('active');
  $('topbar-title').textContent = 'caxt';
};

// ============================================================
// NEW CHAT SHEET
// ============================================================
function openSheet(id) {
  $(id).classList.add('active');
}
function closeSheet(id) {
  $(id).classList.remove('active');
}

$('btn-new-chat').onclick = () => {
  openSheet('newchat-backdrop');
  $('dm-search').value = '';
  $('dm-results').innerHTML = '';
  $('group-name').value = '';
  $('group-search').value = '';
  $('group-results').innerHTML = '';
  $('group-selected').innerHTML = '';
  $('group-error').textContent = '';
  groupMembers = new Map();
};

$('newchat-backdrop').onclick = (e) => {
  if (e.target === $('newchat-backdrop')) closeSheet('newchat-backdrop');
};

document.querySelectorAll('.sheet-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    $('sheet-dm').style.display = which === 'dm' ? 'flex' : 'none';
    $('sheet-group').style.display = which === 'group' ? 'flex' : 'none';
  };
});

// ============================================================
// DM SEARCH
// ============================================================
let dmSearchTimer = null;
$('dm-search').oninput = () => {
  clearTimeout(dmSearchTimer);
  dmSearchTimer = setTimeout(searchDmUser, 300);
};

async function searchDmUser() {
  const term = $('dm-search').value.trim().toLowerCase();
  const resultsEl = $('dm-results');
  if (!term) { resultsEl.innerHTML = ''; return; }

  const snap = await getDoc(doc(db, 'displayNames', term));
  if (!snap.exists()) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">No user found.</div>';
    return;
  }
  const uid = snap.data().uid;
  if (uid === currentUser.uid) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">That\'s you.</div>';
    return;
  }
  const prof = await getProfile(uid);
  resultsEl.innerHTML = `
    <div class="search-result" id="dm-result-click">
      <div class="avatar">${esc(initials(prof.displayName))}</div>
      <div style="font-weight:600">${esc(prof.displayName)}</div>
    </div>`;
  $('dm-result-click').onclick = () => startDmWith(uid);
}

async function startDmWith(otherUid) {
  closeSheet('newchat-backdrop');

  // Check if DM already exists
  const q = query(
    collection(db, 'conversations'),
    where('type', '==', 'dm'),
    where('participants', 'array-contains', currentUser.uid)
  );
  const snap = await getDocs(q);
  let existing = null;
  snap.forEach(d => {
    const data = d.data();
    if (data.participants.includes(otherUid) && data.participants.length === 2) {
      existing = { id: d.id, ...data };
    }
  });

  if (existing) {
    return openConversation(existing);
  }

  const convRef = await addDoc(collection(db, 'conversations'), {
    type: 'dm',
    participants: [currentUser.uid, otherUid],
    lastMessage: '',
    lastMessageAt: Date.now(),
    createdAt: Date.now()
  });
  openConversation({ id: convRef.id, type: 'dm', participants: [currentUser.uid, otherUid], lastMessage: '', lastMessageAt: Date.now() });
}

// ============================================================
// GROUP CREATE
// ============================================================
let groupMembers = new Map();  // uid → displayName

$('group-search').oninput = async () => {
  const term = $('group-search').value.trim().toLowerCase();
  const resultsEl = $('group-results');
  if (!term) { resultsEl.innerHTML = ''; return; }

  const snap = await getDoc(doc(db, 'displayNames', term));
  if (!snap.exists()) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">No user found.</div>';
    return;
  }
  const uid = snap.data().uid;
  if (uid === currentUser.uid) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">That\'s you.</div>';
    return;
  }
  if (groupMembers.has(uid)) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px;">Already added.</div>';
    return;
  }
  const prof = await getProfile(uid);
  resultsEl.innerHTML = `
    <div class="search-result" id="group-result-click">
      <div class="avatar">${esc(initials(prof.displayName))}</div>
      <div style="font-weight:600">${esc(prof.displayName)}</div>
      <div style="margin-left:auto;color:var(--accent);font-weight:700">+ Add</div>
    </div>`;
  $('group-result-click').onclick = () => {
    groupMembers.set(uid, prof.displayName);
    $('group-search').value = '';
    resultsEl.innerHTML = '';
    renderGroupChips();
  };
};

function renderGroupChips() {
  const el = $('group-selected');
  el.innerHTML = '';
  groupMembers.forEach((name, uid) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `${esc(name)} <span class="chip-remove" data-uid="${uid}">×</span>`;
    el.appendChild(chip);
  });
  el.querySelectorAll('.chip-remove').forEach(r => {
    r.onclick = () => {
      groupMembers.delete(r.dataset.uid);
      renderGroupChips();
    };
  });
}

$('btn-create-group').onclick = async () => {
  const name = $('group-name').value.trim();
  const errEl = $('group-error');
  errEl.textContent = '';

  if (!name) return errEl.textContent = 'Enter a group name.';
  if (groupMembers.size === 0) return errEl.textContent = 'Add at least one member.';

  const btn = $('btn-create-group');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const participants = [currentUser.uid, ...groupMembers.keys()];
    const convRef = await addDoc(collection(db, 'conversations'), {
      type: 'group',
      name,
      participants,
      lastMessage: '',
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      createdBy: currentUser.uid
    });
    closeSheet('newchat-backdrop');
    openConversation({ id: convRef.id, type: 'group', name, participants, lastMessage: '', lastMessageAt: Date.now() });
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create group';
  }
};

// ============================================================
// MENU
// ============================================================
$('btn-menu').onclick = () => openSheet('menu-backdrop');
$('menu-backdrop').onclick = (e) => {
  if (e.target === $('menu-backdrop')) closeSheet('menu-backdrop');
};
$('menu-signout').onclick = async () => {
  if (conversationsUnsub) conversationsUnsub();
  if (messagesUnsub) messagesUnsub();
  await signOut(auth);
  closeSheet('menu-backdrop');
};

// ============================================================
// CHAT MENU (members / leave)
// ============================================================
$('btn-chat-menu').onclick = async () => {
  if (!currentConversation) return;
  const c = currentConversation;
  const content = $('chatmenu-content');
  $('chatmenu-title').textContent = c.type === 'group' ? 'Group info' : 'Chat info';

  if (c.type === 'group') {
    let membersHtml = '';
    for (const uid of c.participants) {
      const p = await getProfile(uid);
      membersHtml += `<div style="padding:6px 0;color:var(--text)">${esc(p.displayName)}${uid === currentUser.uid ? ' (you)' : ''}</div>`;
    }
    content.innerHTML = `
      <div class="menu-info"><b>${c.participants.length}</b> members</div>
      ${membersHtml}
      <button class="menu-btn danger" id="chatmenu-leave" style="margin-top:16px;">Leave group</button>
    `;
    $('chatmenu-leave').onclick = async () => {
      if (!confirm('Leave this group?')) return;
      const ref = doc(db, 'conversations', c.id);
      const snap = await getDoc(ref);
      const updated = (snap.data().participants || []).filter(u => u !== currentUser.uid);
      if (updated.length === 0) {
        await deleteDoc(ref);
      } else {
        await updateDoc(ref, { participants: updated });
      }
      closeSheet('chatmenu-backdrop');
      $('btn-back').click();
    };
  } else {
    const otherUid = c.participants.find(p => p !== currentUser.uid);
    const p = await getProfile(otherUid);
    content.innerHTML = `
      <div style="text-align:center; padding:16px 0;">
        <div class="avatar" style="width:72px; height:72px; font-size:28px; margin:0 auto 12px;">${esc(initials(p.displayName))}</div>
        <div style="font-size:18px; font-weight:600;">${esc(p.displayName)}</div>
      </div>
    `;
  }
  openSheet('chatmenu-backdrop');
};

$('chatmenu-backdrop').onclick = (e) => {
  if (e.target === $('chatmenu-backdrop')) closeSheet('chatmenu-backdrop');
};