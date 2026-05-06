/* =========================================================
   SAFEPASS – script.js  v4.2
   - REAL-TIME cross-device sync via Firestore onSnapshot
   - Max 3 pickers, QR scanner, picker tap-to-approve
   - Firebase online + localStorage fallback
   - Firebase: unified firebaseConfig + SDK 10.12.2 (matches HTML)
   ========================================================= */

'use strict';

// ADMIN_USERS is now dynamic — stored in localStorage/Firestore.
// The first-ever user to register becomes the super-admin.
const MAX_FAILED  = 3;
const LOCK_SECS   = 30;
const MAX_PERSONS = 3;
const BASE_URL    = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
const VERIFY_URL  = BASE_URL + 'verify.html';
const CARD_URL    = BASE_URL + 'card.html';

/** Same version as index.html Firebase CDN (avoid loading two SDK versions). */
const FIREBASE_SDK_VERSION = '10.12.2';
const FIREBASE_CDN_BASE = 'https://www.gstatic.com/firebasejs/' + FIREBASE_SDK_VERSION;

// ── Firebase state ────────────────────────────────────────
let _db              = null;   // Firestore instance
let _unsubStudents   = null;   // live listener unsubscribe fn
let _liveStudents    = null;   // in-memory cache fed by onSnapshot
let _firebaseReady   = false;

// ── Firebase init (loads SDKs if needed; call after firebase-config.js) ─
async function initFirebase() {
  if (typeof FIREBASE_ENABLED === 'undefined' || !FIREBASE_ENABLED) return false;
  if (_firebaseReady) return true;
  if (typeof firebaseConfig === 'undefined') {
    console.warn('firebaseConfig is missing — check firebase-config.js');
    return false;
  }
  try {
    if (typeof firebase === 'undefined') {
      await loadScript(FIREBASE_CDN_BASE + '/firebase-app-compat.js');
      await loadScript(FIREBASE_CDN_BASE + '/firebase-firestore-compat.js');
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    _db = firebase.firestore();
    try { await _db.enablePersistence({ synchronizeTabs: true }); } catch (e) {}
    _firebaseReady = true;
    return true;
  } catch (e) {
    console.warn('Firebase init failed, using localStorage:', e);
    return false;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── DB abstraction ────────────────────────────────────────
// Always writes to Firestore (triggers onSnapshot on all devices).
// Falls back to localStorage when Firebase not configured.
const DB = {
  _get: k => { try { return JSON.parse(localStorage.getItem('sp_' + k)) || null; } catch { return null; } },
  _set: (k, v) => localStorage.setItem('sp_' + k, JSON.stringify(v)),

  async getStudents() {
    // Use live in-memory cache if available (populated by onSnapshot)
    if (_liveStudents !== null) return _liveStudents;
    // Fallback: one-time Firestore read
    if (_db) {
      try {
        const snap = await _db.collection('students').orderBy('createdAt', 'desc').get();
        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _liveStudents = arr;
        DB._set('students', arr);
        return arr;
      } catch (e) { console.warn('Firestore read fail:', e); }
    }
    return this._get('students') || [];
  },

  // saveStudent writes to Firestore → triggers onSnapshot on ALL devices instantly
  async saveStudent(s) {
    // Always update local cache immediately for snappy UI
    if (_liveStudents !== null) {
      const idx = _liveStudents.findIndex(x => x.id === s.id);
      if (idx >= 0) _liveStudents[idx] = s; else _liveStudents.unshift(s);
    }
    const students = _liveStudents || (this._get('students') || []);
    const idx = students.findIndex(x => x.id === s.id);
    if (idx >= 0) students[idx] = s; else students.unshift(s);
    this._set('students', students);

    if (_db) {
      try {
        // merge:true avoids overwriting fields we didn't touch
        await _db.collection('students').doc(s.id).set(s, { merge: false });
      } catch (e) { console.warn('Firestore save fail:', e); }
    }
  },

  async deleteStudent(id) {
    if (_liveStudents !== null) _liveStudents = _liveStudents.filter(s => s.id !== id);
    const students = (this._get('students') || []).filter(s => s.id !== id);
    this._set('students', students);
    if (_db) { try { await _db.collection('students').doc(id).delete(); } catch (e) {} }
  },

  getLogs:   () => DB._get('logs') || [],
  setLogs:   v  => DB._set('logs', v),
  getUnauth: () => DB._get('unauth') || [],
  setUnauth: v  => DB._set('unauth', v),
};

// ── Admin Users DB ────────────────────────────────────────
// Stored under 'adminUsers' key. First registered user = super-admin.
const AdminDB = {
  getAll() {
    return DB._get('adminUsers') || [];
  },
  find(username) {
    return this.getAll().find(a => a.username.toLowerCase() === username.toLowerCase()) || null;
  },
  save(user) {
    const all = this.getAll();
    const idx = all.findIndex(a => a.username.toLowerCase() === user.username.toLowerCase());
    if (idx >= 0) all[idx] = user; else all.push(user);
    DB._set('adminUsers', all);
    // Sync to Firestore if available
    if (_db) { try { _db.collection('adminUsers').doc(user.username).set(user, {merge:false}); } catch(e){} }
  },
  delete(username) {
    const all = this.getAll().filter(a => a.username.toLowerCase() !== username.toLowerCase());
    DB._set('adminUsers', all);
    if (_db) { try { _db.collection('adminUsers').doc(username).delete(); } catch(e){} }
  },
  async syncFromFirestore() {
    if (!_db) return;
    try {
      const snap = await _db.collection('adminUsers').get();
      if (!snap.empty) {
        const arr = snap.docs.map(d => d.data());
        DB._set('adminUsers', arr);
      }
    } catch(e) {}
  },
  isSuperAdmin(username) {
    const all = this.getAll();
    return all.length === 0 || (all[0] && all[0].username.toLowerCase() === username.toLowerCase());
  }
};

// ── Real-time listener: keeps _liveStudents updated on ALL devices ──
// Call once after initFirebase(). Fires instantly when any device saves.
function startLiveStudentsListener(onUpdate) {
  if (!_db) return;
  if (_unsubStudents) { _unsubStudents(); _unsubStudents = null; }
  _unsubStudents = _db.collection('students')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      _liveStudents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      DB._set('students', _liveStudents);
      if (typeof onUpdate === 'function') onUpdate(_liveStudents);
    }, err => {
      console.warn('Firestore live listener error:', err);
    });
}

// ── Utilities ─────────────────────────────────────────────
function genId() { return 'SP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2,5).toUpperCase(); }
function nowStr() { return new Date().toLocaleString('en-GB', { hour12:true, day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
function today() { return new Date().toDateString(); }
function initials(name) { if (!name) return '?'; return name.split(' ').map(w => w[0]).join('').toUpperCase().substr(0,2); }
function showToast(type, msg) {
  const t = document.getElementById(type==='success'?'successToast':'errorToast');
  const m = document.getElementById(type==='success'?'successToastMsg':'errorToastMsg');
  if (!t||!m) return; m.textContent = msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3200);
}
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function overlayClose(e,id) { if (e.target===document.getElementById(id)) closeModal(id); }
function addLog(type, msg) {
  const logs = DB.getLogs(); logs.unshift({ type, msg, time:nowStr(), date:today() });
  if (logs.length>200) logs.pop(); DB.setLogs(logs);
}
function statusBadge(s) {
  const pickedToday = s.lastPickedDate === getTodayDateStr();
  return pickedToday
    ? '<span class="badge badge-blue"><i class="fas fa-circle-check"></i> Picked Today</span>'
    : '<span class="badge badge-green"><i class="fas fa-school"></i> In School</span>';
}

// ============================================================
//  DAILY SCAN ELIGIBILITY — does NOT wipe pickup history.
//  Each student gets a lastPickedDate field. On a new school
//  day the QR scanner simply checks if lastPickedDate < today,
//  meaning the child is eligible to be scanned again.
//  All historical pickedAt / pickedBy records are preserved.
// ============================================================
const RESET_KEY = 'sp_lastResetDate';

function getTodayDateStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

/** Returns true if student is eligible to be scanned/picked today */
function isEligibleToday(s) {
  return s.lastPickedDate !== getTodayDateStr();
}

async function runDailyResetIfNeeded() {
  // Only marks the reset date — no data is changed.
  // Scan eligibility is evaluated live via isEligibleToday().
  const todayStr = new Date().toDateString();
  const lastReset = localStorage.getItem(RESET_KEY);
  if (lastReset === todayStr) return;
  localStorage.setItem(RESET_KEY, todayStr);
  addLog('info', `New school day started: ${todayStr}. All students eligible for today's pickup.`);
}

// ============================================================
//  SCHOOL DAY CHECK — Uganda public holidays + weekends
// ============================================================
const UGANDA_PUBLIC_HOLIDAYS = {
  '01-01': "New Year's Day",
  '01-26': 'Liberation Day',
  '03-08': "International Women's Day",
  '05-01': 'Labour Day',
  '06-03': 'Martyrs Day',
  '06-09': 'National Heroes Day',
  '10-09': 'Independence Day',
  '12-25': 'Christmas Day',
  '12-26': 'Boxing Day',
  // Easter moves yearly — approximate Good Friday/Easter Mon handled dynamically
};

function getEasterDates(year) {
  // Anonymous Gregorian algorithm
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
        m=Math.floor((a+11*h+22*l)/451),
        month=Math.floor((h+l-7*m+114)/31),
        day=((h+l-7*m+114)%31)+1;
  const easter=new Date(year,month-1,day);
  const goodFriday=new Date(easter); goodFriday.setDate(easter.getDate()-2);
  const easterMon=new Date(easter); easterMon.setDate(easter.getDate()+1);
  return [goodFriday,easter,easterMon];
}

function getSchoolDayStatus() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun,6=Sat
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  const key = `${mm}-${dd}`;

  if (dow === 0) return { allowed:false, reason:'Sunday — School is closed today.' };
  if (dow === 6) return { allowed:false, reason:'Saturday — No school today.' };

  if (UGANDA_PUBLIC_HOLIDAYS[key]) {
    return { allowed:false, reason:`🇺🇬 Public Holiday: ${UGANDA_PUBLIC_HOLIDAYS[key]}. School is closed.` };
  }
  // Dynamic Easter check
  const easterDates = getEasterDates(now.getFullYear());
  for (const d of easterDates) {
    if (d.toDateString()===now.toDateString()) {
      return { allowed:false, reason:`🇺🇬 Public Holiday: ${d===easterDates[0]?'Good Friday':d===easterDates[1]?'Easter Sunday':'Easter Monday'}. School is closed.` };
    }
  }
  return { allowed:true, reason:null };
}

// ── Seed demo data ────────────────────────────────────────
async function seedDemoData() {
  if ((DB._get('students')||[]).length) return;
  const students = [
    { id:genId(), createdAt:Date.now(), name:'Amara Okonkwo', grade:'Grade 4', stream:'Blue Stream',
      school:'SafePass Academy', photo:'', parentName:'Mrs. Grace Okonkwo', parentPhoto:'',
      status:'IN_SCHOOL', pickedAt:null, pickedBy:null, qrActive:true, qrVersion:1,
      persons:[{ id:genId(), name:'James Okonkwo', relationship:'Father', phone:'+256 700 111 222', photo:'' }]
    },
    { id:genId(), createdAt:Date.now()-1000, name:'Tariq Al-Hassan', grade:'Grade 6', stream:'Red Stream',
      school:'SafePass Academy', photo:'', parentName:'Mr. Yusuf Al-Hassan', parentPhoto:'',
      status:'PICKED', pickedAt:nowStr(), pickedBy:'Fatima Al-Hassan (Mother)', qrActive:true, qrVersion:1,
      persons:[
        { id:genId(), name:'Fatima Al-Hassan', relationship:'Mother', phone:'+256 700 333 444', photo:'' },
        { id:genId(), name:'Khalid Al-Hassan', relationship:'Brother', phone:'', photo:'' }
      ]
    }
  ];
  DB._set('students', students);
  addLog('info', 'System initialized with demo student data.');
}

// ============================================================
//  PHOTO CAMERA MODULE
// ============================================================
let _cameraStream=null, _cameraCallback=null, _useFrontCam=true;

function openCamera(onCapture, label) {
  _cameraCallback = onCapture;
  let modal = document.getElementById('cameraModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'cameraModal'; modal.className = 'modal-overlay open';
    modal.innerHTML = `<div class="modal glass-modal camera-modal">
      <div class="modal-icon" style="background:rgba(69,123,157,.15)"><i class="fas fa-camera"></i></div>
      <h3 id="cameraModalLabel">Take Photo</h3>
      <div class="camera-wrap">
        <video id="cameraVideo" autoplay playsinline muted></video>
        <canvas id="cameraCanvas" style="display:none"></canvas>
        <div class="camera-overlay-ring"></div>
      </div>
      <div class="camera-btn-row">
        <button class="btn btn-secondary" onclick="closeCamera()"><i class="fas fa-xmark"></i> Cancel</button>
        <button class="btn btn-primary camera-snap-btn" onclick="snapPhoto()"><i class="fas fa-circle"></i> Capture</button>
        <button class="btn btn-secondary" onclick="switchCamera()" title="Switch camera"><i class="fas fa-rotate"></i></button>
      </div>
      <div class="camera-hint"><i class="fas fa-circle-info"></i> Position face clearly in frame</div>
    </div>`;
    document.body.appendChild(modal);
  } else { modal.classList.add('open'); }
  document.getElementById('cameraModalLabel').textContent = label||'Take Photo';
  startPhotoCamera();
}

async function startPhotoCamera() {
  stopCamera();
  try {
    _cameraStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:_useFrontCam?'user':'environment', width:{ideal:640}, height:{ideal:640} } });
    const v = document.getElementById('cameraVideo');
    if (v) { v.srcObject = _cameraStream; await v.play(); }
  } catch(e) { showToast('error','Camera access denied.'); closeCamera(); }
}
async function switchCamera() { _useFrontCam=!_useFrontCam; await startPhotoCamera(); }
function snapPhoto() {
  const v=document.getElementById('cameraVideo'), c=document.getElementById('cameraCanvas');
  if (!v||!c) return;
  const size=Math.min(v.videoWidth,v.videoHeight); c.width=size; c.height=size;
  const ctx=c.getContext('2d'); ctx.drawImage(v,(v.videoWidth-size)/2,(v.videoHeight-size)/2,size,size,0,0,size,size);
  if (_cameraCallback) _cameraCallback(c.toDataURL('image/jpeg',0.8));
  closeCamera();
}
function stopCamera() { if (_cameraStream) { _cameraStream.getTracks().forEach(t=>t.stop()); _cameraStream=null; } }
function closeCamera() { stopCamera(); document.getElementById('cameraModal')?.classList.remove('open'); }

// ── Photo widget ──────────────────────────────────────────
function photoWidget(opts) {
  const val=opts.value||'', has=val&&val.length>50;
  return `<div class="photo-widget" id="pw-${opts.id}">
    <div class="pw-preview ${has?'has-photo':''}" id="pwprev-${opts.id}">
      ${has ? `<img src="${val}" alt="photo" id="pwimg-${opts.id}"/>
               <button class="pw-remove-btn" type="button" onclick="clearPhotoWidget('${opts.id}')"><i class="fas fa-xmark"></i></button>`
            : `<div class="pw-placeholder"><i class="fas fa-user"></i></div>`}
    </div>
    <input type="hidden" id="pwdata-${opts.id}" value="${val}"/>
    <div class="pw-actions">
      <label class="pw-btn pw-btn-upload"><i class="fas fa-image"></i> Upload
        <input type="file" accept="image/*" style="display:none" onchange="handlePhotoUpload(this,'${opts.id}')"/>
      </label>
      <button type="button" class="pw-btn pw-btn-camera" onclick="openCamera(d=>setPhotoWidget('${opts.id}',d),'${opts.label||'Take Photo'}')">
        <i class="fas fa-camera"></i> Camera
      </button>
    </div>
  </div>`;
}
function handlePhotoUpload(input,widgetId) {
  const file=input.files[0]; if (!file) return;
  if (file.size>8*1024*1024) { showToast('error','Image too large (max 8MB).'); return; }
  const reader=new FileReader();
  reader.onload=e=>{ const img=new Image(); img.onload=()=>{
    const canvas=document.createElement('canvas'); const MAX=600; let w=img.width,h=img.height;
    if (w>h){ if(w>MAX){h=h*MAX/w;w=MAX;} } else { if(h>MAX){w=w*MAX/h;h=MAX;} }
    canvas.width=w; canvas.height=h; canvas.getContext('2d').drawImage(img,0,0,w,h);
    setPhotoWidget(widgetId,canvas.toDataURL('image/jpeg',0.82));
  }; img.src=e.target.result; };
  reader.readAsDataURL(file);
}
function setPhotoWidget(widgetId,dataUrl) {
  const prev=document.getElementById('pwprev-'+widgetId), dataIn=document.getElementById('pwdata-'+widgetId);
  if (!prev||!dataIn) return; dataIn.value=dataUrl; prev.classList.add('has-photo');
  prev.innerHTML=`<img src="${dataUrl}" alt="photo" id="pwimg-${widgetId}"/>
    <button class="pw-remove-btn" type="button" onclick="clearPhotoWidget('${widgetId}')"><i class="fas fa-xmark"></i></button>`;
}
function clearPhotoWidget(widgetId) {
  const prev=document.getElementById('pwprev-'+widgetId), dataIn=document.getElementById('pwdata-'+widgetId);
  if (!prev||!dataIn) return; dataIn.value=''; prev.classList.remove('has-photo');
  prev.innerHTML=`<div class="pw-placeholder"><i class="fas fa-user"></i></div>`;
}
function getPhotoWidget(widgetId) { return document.getElementById('pwdata-'+widgetId)?.value||''; }

// ============================================================
//  LOGIN PAGE  — Sign In + Sign Up
// ============================================================
async function initLoginPage() {
  seedDemoData();
  if (sessionStorage.getItem('sp_auth')==='1') { window.location.href='dashboard.html'; return; }
  await initFirebase();
  await AdminDB.syncFromFirestore();

  // If no admin users yet, show sign-up mode automatically
  const hasAdmins = AdminDB.getAll().length > 0;
  if (!hasAdmins) { showSignupForm(true); } else { showLoginForm(); }
}

function showLoginForm() {
  const container = document.getElementById('loginContainer');
  container.innerHTML = `
    <div class="login-header">
      <div class="school-logo-wrap">
        <img src="assets/logo.png" alt="School Logo" onerror="this.style.display='none'; document.getElementById('logoFallback').style.display='flex'"/>
        <div class="logo-fallback" id="logoFallback"><i class="fas fa-shield-halved"></i></div>
      </div>
      <h1 class="login-title">SafePass</h1>
      <p class="login-subtitle">School Pickup Security System</p>
      <div class="security-badge"><i class="fas fa-lock"></i><span>Secured Portal</span></div>
    </div>
    <form class="login-form" id="loginForm" autocomplete="off">
      <div class="form-group">
        <label for="adminUsername"><i class="fas fa-user-shield"></i> Username</label>
        <div class="input-wrap">
          <input type="text" id="adminUsername" placeholder="Enter username" autocomplete="off" required/>
          <span class="input-icon"><i class="fas fa-user"></i></span>
        </div>
      </div>
      <div class="form-group">
        <label for="adminPassword"><i class="fas fa-key"></i> Password</label>
        <div class="input-wrap">
          <input type="password" id="adminPassword" placeholder="Enter password" autocomplete="off" required/>
          <span class="input-icon toggle-pw" onclick="togglePassword()">
            <i class="fas fa-eye-slash" id="pwIcon"></i>
          </span>
        </div>
      </div>
      <div class="lock-warning" id="lockWarning" style="display:none">
        <i class="fas fa-ban"></i>
        <span id="lockMsg">Too many failed attempts. Try again in <b id="lockCountdown">30</b>s.</span>
      </div>
      <div class="login-error" id="loginError" style="display:none">
        <i class="fas fa-triangle-exclamation"></i>
        <span id="loginErrMsg">Invalid credentials.</span>
      </div>
      <div class="attempt-dots" id="attemptDots">
        <span class="dot" id="dot1"></span><span class="dot" id="dot2"></span><span class="dot" id="dot3"></span>
      </div>
      <button type="submit" class="btn-login" id="loginBtn">
        <span id="loginBtnText"><i class="fas fa-right-to-bracket"></i> Sign In</span>
        <span id="loginSpinner" style="display:none"><i class="fas fa-circle-notch fa-spin"></i> Verifying...</span>
      </button>
      <div class="login-switch-row">
        <span>Don't have an account?</span>
        <button type="button" class="btn-link" onclick="showSignupForm(false)">Create Account</button>
      </div>
    </form>
    <div class="login-footer"><i class="fas fa-shield-halved"></i> @vayns v2.0 &nbsp;|&nbsp; All rights reserved &copy; 2026</div>`;
  attachLoginHandler();
}

function showSignupForm(isFirst) {
  const container = document.getElementById('loginContainer');
  container.innerHTML = `
    <div class="login-header">
      <div class="school-logo-wrap">
        <img src="assets/logo.png" alt="School Logo" onerror="this.style.display='none';document.getElementById('logoFallback2').style.display='flex'"/>
        <div class="logo-fallback" id="logoFallback2"><i class="fas fa-shield-halved"></i></div>
      </div>
      <h1 class="login-title">Create Account</h1>
      <p class="login-subtitle">${isFirst?'Set up the first admin account':'Register a new admin user'}</p>
      ${isFirst?'<div class="security-badge" style="background:rgba(45,198,83,.15);color:#1a7a38"><i class="fas fa-star"></i><span>First account = Super Admin</span></div>':''}
    </div>
    <form class="login-form" id="signupForm" autocomplete="off">
      <div class="form-group">
        <label><i class="fas fa-id-badge"></i> Full Name *</label>
        <div class="input-wrap">
          <input type="text" id="suFullName" placeholder="e.g. John Ssebayigga" required/>
          <span class="input-icon"><i class="fas fa-user"></i></span>
        </div>
      </div>
      <div class="form-group">
        <label><i class="fas fa-user-shield"></i> Username *</label>
        <div class="input-wrap">
          <input type="text" id="suUsername" placeholder="e.g. john2026" autocomplete="off" required/>
          <span class="input-icon"><i class="fas fa-at"></i></span>
        </div>
      </div>
      <div class="form-group">
        <label><i class="fas fa-key"></i> Password *</label>
        <div class="input-wrap">
          <input type="password" id="suPassword" placeholder="Min 6 characters" autocomplete="new-password" required/>
          <span class="input-icon toggle-pw" onclick="togglePasswordId('suPassword','suPwIcon')">
            <i class="fas fa-eye-slash" id="suPwIcon"></i>
          </span>
        </div>
      </div>
      <div class="form-group">
        <label><i class="fas fa-lock"></i> Confirm Password *</label>
        <div class="input-wrap">
          <input type="password" id="suConfirm" placeholder="Re-enter password" autocomplete="new-password" required/>
          <span class="input-icon toggle-pw" onclick="togglePasswordId('suConfirm','suPwIcon2')">
            <i class="fas fa-eye-slash" id="suPwIcon2"></i>
          </span>
        </div>
      </div>
      <div class="login-error" id="signupError" style="display:none">
        <i class="fas fa-triangle-exclamation"></i>
        <span id="signupErrMsg">Error.</span>
      </div>
      <button type="submit" class="btn-login" id="signupBtn">
        <span id="signupBtnText"><i class="fas fa-user-plus"></i> Create Account</span>
        <span id="signupSpinner" style="display:none"><i class="fas fa-circle-notch fa-spin"></i> Creating...</span>
      </button>
      ${!isFirst?`<div class="login-switch-row"><span>Already have an account?</span><button type="button" class="btn-link" onclick="showLoginForm()">Sign In</button></div>`:''}
    </form>
    <div class="login-footer"><i class="fas fa-shield-halved"></i> @vayns v2.0 &nbsp;|&nbsp; All rights reserved &copy; 2026</div>`;
  attachSignupHandler(isFirst);
}

function attachLoginHandler() {
  const form=document.getElementById('loginForm'),
        errEl=document.getElementById('loginError'), errMsg=document.getElementById('loginErrMsg'),
        lockEl=document.getElementById('lockWarning'), lockCnt=document.getElementById('lockCountdown'),
        btn=document.getElementById('loginBtn'), btnTxt=document.getElementById('loginBtnText'),
        spinner=document.getElementById('loginSpinner'),
        dots=['dot1','dot2','dot3'].map(id=>document.getElementById(id));
  let fails=parseInt(localStorage.getItem('sp_fails')||'0'), lockUntil=parseInt(localStorage.getItem('sp_lockUntil')||'0');
  function checkLock() {
    if (Date.now()<lockUntil) {
      btn.disabled=true; lockEl.style.display='flex'; errEl.style.display='none';
      const iv=setInterval(()=>{ const rem=Math.ceil((lockUntil-Date.now())/1000);
        if(rem<=0){clearInterval(iv);btn.disabled=false;lockEl.style.display='none';fails=0;localStorage.removeItem('sp_fails');localStorage.removeItem('sp_lockUntil');dots.forEach(d=>d?.classList.remove('active'));}else{lockCnt.textContent=rem;}},500);
      return true; } return false; }
  checkLock();
  form.addEventListener('submit', e=>{
    e.preventDefault(); if(checkLock()) return;
    btnTxt.style.display='none'; spinner.style.display='inline'; btn.disabled=true;
    setTimeout(()=>{
      const u=document.getElementById('adminUsername').value.trim(), p=document.getElementById('adminPassword').value;
      btnTxt.style.display='inline'; spinner.style.display='none';
      const adminUser = AdminDB.find(u);
      if (adminUser && adminUser.password === p) {
        fails=0; localStorage.removeItem('sp_fails'); localStorage.removeItem('sp_lockUntil');
        sessionStorage.setItem('sp_auth','1');
        sessionStorage.setItem('sp_user', JSON.stringify({username:adminUser.username, fullName:adminUser.fullName, role:adminUser.role}));
        addLog('info',`"${adminUser.fullName||adminUser.username}" logged in.`);
        window.location.href='dashboard.html';
      } else {
        fails++; localStorage.setItem('sp_fails',fails);
        if(fails<MAX_FAILED) dots[fails-1]?.classList.add('active');
        if(fails>=MAX_FAILED){lockUntil=Date.now()+LOCK_SECS*1000;localStorage.setItem('sp_lockUntil',lockUntil);checkLock();}
        else{errMsg.textContent=`Invalid credentials. ${MAX_FAILED-fails} attempt(s) remaining.`;errEl.style.display='flex';btn.disabled=false;}
        document.getElementById('adminPassword').value=''; document.getElementById('adminPassword').focus();
      }
    },900);
  });
}

function attachSignupHandler(isFirst) {
  document.getElementById('signupForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const errEl=document.getElementById('signupError'), errMsg=document.getElementById('signupErrMsg');
    const btn=document.getElementById('signupBtn'), btnTxt=document.getElementById('signupBtnText'), spinner=document.getElementById('signupSpinner');
    const fullName=document.getElementById('suFullName').value.trim(),
          username=document.getElementById('suUsername').value.trim(),
          password=document.getElementById('suPassword').value,
          confirm=document.getElementById('suConfirm').value;
    function showErr(msg){ errMsg.textContent=msg; errEl.style.display='flex'; btn.disabled=false; btnTxt.style.display='inline'; spinner.style.display='none'; }
    if(!fullName){showErr('Full name is required.');return;}
    if(!username||username.length<3){showErr('Username must be at least 3 characters.');return;}
    if(!/^[a-zA-Z0-9_]+$/.test(username)){showErr('Username can only contain letters, numbers and underscores.');return;}
    if(password.length<6){showErr('Password must be at least 6 characters.');return;}
    if(password!==confirm){showErr('Passwords do not match.');return;}
    if(AdminDB.find(username)){showErr('That username is already taken. Choose another.');return;}
    btnTxt.style.display='none'; spinner.style.display='inline'; btn.disabled=true;
    const all=AdminDB.getAll();
    const newUser={ username, fullName, password, role: all.length===0?'super-admin':'admin', createdAt:Date.now() };
    AdminDB.save(newUser);
    addLog('info',`New admin account created: "${fullName}" (${username}).`);
    // Auto login after signup
    sessionStorage.setItem('sp_auth','1');
    sessionStorage.setItem('sp_user', JSON.stringify({username:newUser.username, fullName:newUser.fullName, role:newUser.role}));
    window.location.href='dashboard.html';
  });
}

function togglePassword() {
  const p=document.getElementById('adminPassword'),i=document.getElementById('pwIcon');
  if(p.type==='password'){p.type='text';i.className='fas fa-eye';}else{p.type='password';i.className='fas fa-eye-slash';}
}
function togglePasswordId(inputId, iconId) {
  const p=document.getElementById(inputId), i=document.getElementById(iconId);
  if(p.type==='password'){p.type='text';i.className='fas fa-eye';}else{p.type='password';i.className='fas fa-eye-slash';}
}

// ============================================================
//  DASHBOARD
// ============================================================
let _currentSection = 'overview';

async function initDashboard() {
  if (sessionStorage.getItem('sp_auth')!=='1') { window.location.href='index.html'; return; }
  seedDemoData();
  await initFirebase();
  await AdminDB.syncFromFirestore();
  await runDailyResetIfNeeded();
  updateClock();
  setInterval(updateClock, 1000);

  // Show logged-in user name in topbar
  const userData = JSON.parse(sessionStorage.getItem('sp_user')||'{}');
  const userSpan = document.querySelector('.topbar-user span');
  if (userSpan && userData.fullName) userSpan.textContent = userData.fullName;
  const userAvatar = document.querySelector('.user-avatar');
  if (userAvatar && userData.role==='super-admin') {
    userAvatar.innerHTML = '<i class="fas fa-user-shield"></i>';
    userAvatar.title = 'Super Admin';
  }

  // ── Real-time listener: auto-refreshes current view on ANY device change ──
  startLiveStudentsListener(() => {
    const liveRefresh = ['overview','students','picked','qrmanager'];
    if (liveRefresh.includes(_currentSection)) {
      showLiveSyncPulse();
      reloadCurrentSection();
    }
  });

  loadSection('overview');
}

function showLiveSyncPulse() {
  let pill = document.getElementById('liveSyncPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'liveSyncPill';
    pill.style.cssText = 'position:fixed;top:72px;right:18px;background:#2dc653;color:#fff;font-size:.72rem;font-weight:700;padding:5px 12px;border-radius:99px;box-shadow:0 3px 12px rgba(45,198,83,.4);z-index:9999;display:flex;align-items:center;gap:6px;transition:opacity .4s';
    pill.innerHTML = '<i class="fas fa-circle" style="font-size:.4rem;animation:pulse 1s infinite"></i> Live update received';
    document.body.appendChild(pill);
  }
  pill.style.opacity = '1';
  clearTimeout(pill._hide);
  pill._hide = setTimeout(() => { pill.style.opacity = '0'; }, 2200);
}

async function reloadCurrentSection() {
  switch (_currentSection) {
    case 'overview':  await renderOverview();  break;
    case 'students':  await renderStudents();  break;
    case 'picked':    await renderPicked();    break;
    case 'qrmanager': await renderQRManager(); break;
  }
}

function updateClock() { const el=document.getElementById('topbarTime'); if(el) el.textContent=new Date().toLocaleTimeString('en-GB',{hour12:true}); }
function adminLogout() {
  const userData = JSON.parse(sessionStorage.getItem('sp_user')||'{}');
  addLog('info',`"${userData.fullName||userData.username||'Admin'}" logged out.`);
  sessionStorage.removeItem('sp_auth');
  sessionStorage.removeItem('sp_user');
  window.location.href='index.html';
}
function openSidebar()  { document.getElementById('sidebar')?.classList.add('open'); document.getElementById('sidebarOverlay')?.classList.add('open'); }
function closeSidebar() { document.getElementById('sidebar')?.classList.remove('open'); document.getElementById('sidebarOverlay')?.classList.remove('open'); }

function loadSection(name) {
  _currentSection = name;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.section===name));
  const labels={overview:'Dashboard',students:'All Students',picked:'Picked Today',register:'Register Student',qrmanager:'QR Manager',unauthorized:'Unauthorized Attempts',search:'Search Student',logs:'Activity Logs',streams:'Streams',admins:'Admin Users'};
  const bc=document.getElementById('breadcrumbSection'); if(bc) bc.textContent=labels[name]||name;
  closeSidebar();
  const mc=document.getElementById('mainContent');
  mc.innerHTML='<div class="loading-placeholder"><i class="fas fa-circle-notch fa-spin"></i><span>Loading...</span></div>';
  setTimeout(async()=>{
    switch(name){
      case 'overview':     await renderOverview();    break;
      case 'students':     await renderStudents();    break;
      case 'picked':       await renderPicked();      break;
      case 'register':     renderRegister();          break;
      case 'qrmanager':    await renderQRManager();   break;
      case 'unauthorized': renderUnauthorized();      break;
      case 'search':       renderSearch();            break;
      case 'logs':         renderLogs();              break;
      case 'streams':      await renderStreams();      break;
      case 'admins':       renderAdmins();            break;
    }},220);
}

async function renderOverview() {
  const students=await DB.getStudents(), total=students.length,
        todayStr=getTodayDateStr(),
        inSchool=students.filter(s=>s.lastPickedDate!==todayStr).length,
        picked=students.filter(s=>s.lastPickedDate===todayStr).length,
        unauth=DB.getUnauth().length, logs=DB.getLogs().slice(0,6);
  document.getElementById('mainContent').innerHTML=`
    <div class="stats-grid">
      <div class="stat-card blue" onclick="loadSection('students')" style="cursor:pointer"><div class="stat-icon"><i class="fas fa-children"></i></div><div class="stat-info"><div class="stat-label">Total Students</div><div class="stat-value">${total}</div></div></div>
      <div class="stat-card green" onclick="loadSection('students')" style="cursor:pointer"><div class="stat-icon"><i class="fas fa-school"></i></div><div class="stat-info"><div class="stat-label">In School</div><div class="stat-value">${inSchool}</div></div></div>
      <div class="stat-card orange" onclick="loadSection('picked')" style="cursor:pointer"><div class="stat-icon"><i class="fas fa-circle-check"></i></div><div class="stat-info"><div class="stat-label">Picked Today</div><div class="stat-value">${picked}</div></div></div>
      <div class="stat-card red" onclick="loadSection('unauthorized')" style="cursor:pointer"><div class="stat-icon"><i class="fas fa-triangle-exclamation"></i></div><div class="stat-info"><div class="stat-label">Unauth Attempts</div><div class="stat-value">${unauth}</div></div></div>
    </div>
    <div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-clock-rotate-left"></i> Recent Activity</div><button class="btn btn-secondary btn-sm" onclick="loadSection('logs')">View All</button></div>
    <div class="log-list">${logs.length?logs.map(renderLogItem).join(''):'<div class="empty-state"><i class="fas fa-inbox"></i><p>No activity yet.</p></div>'}</div></div>
    <div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-children"></i> Recent Students</div><button class="btn btn-primary btn-sm" onclick="loadSection('register')"><i class="fas fa-plus"></i> Add Student</button></div>
    ${renderStudentTable(students.slice(0,5),true)}</div>`;
}

async function renderStudents(filterStream, filterGender) {
  const students=await DB.getStudents();
  const streams=[...new Set(students.map(s=>s.stream).filter(Boolean))].sort();
  const activeStream=filterStream||'all';
  const activeGender=filterGender||'all';
  const filtered=students.filter(s=>{
    const streamOk=activeStream==='all'||s.stream===activeStream;
    const genderOk=activeGender==='all'||s.gender===activeGender;
    return streamOk&&genderOk;
  });
  const streamTabs=`<div class="stream-tabs">
    <button class="stream-tab${activeStream==='all'?' active':''}" onclick="renderStudents('all','${activeGender}')"><i class="fas fa-layer-group"></i> All <span class="stream-tab-count">${students.length}</span></button>
    ${streams.map(st=>{
      const count=students.filter(s=>s.stream===st).length;
      return `<button class="stream-tab${activeStream===st?' active':''}" onclick="renderStudents('${st.replace(/'/g,"\\'")}','${activeGender}')">${st} <span class="stream-tab-count">${count}</span></button>`;
    }).join('')}
  </div>`;
  const genderBar=`<div class="gender-filter-bar">
    <button class="gender-btn${activeGender==='all'?' active':''}" onclick="renderStudents('${activeStream}','all')">All</button>
    <button class="gender-btn male${activeGender==='Male'?' active':''}" onclick="renderStudents('${activeStream}','Male')"><i class="fas fa-mars"></i> Boys</button>
    <button class="gender-btn female${activeGender==='Female'?' active':''}" onclick="renderStudents('${activeStream}','Female')"><i class="fas fa-venus"></i> Girls</button>
  </div>`;
  document.getElementById('mainContent').innerHTML=`
    <div class="panel">
      <div class="section-header"><div class="section-title"><i class="fas fa-children"></i> All Students (${students.length})</div><button class="btn btn-primary btn-sm" onclick="loadSection('register')"><i class="fas fa-plus"></i> Register</button></div>
      ${streamTabs}
      <div class="students-toolbar">
        ${genderBar}
        <div class="search-bar-wrap"><span class="search-icon"><i class="fas fa-magnifying-glass"></i></span><input type="text" placeholder="Search name, grade, stream…" oninput="filterStudentLive(this.value,'${activeStream}','${activeGender}')"/></div>
      </div>
      <div class="stream-showing-label">${activeStream==='all'?'Showing all streams':'Stream: <strong>'+activeStream+'</strong>'} &nbsp;·&nbsp; ${filtered.length} student${filtered.length!==1?'s':''}</div>
      ${renderStudentTable(filtered,false)}
    </div>`;
}

async function filterStudentLive(q, stream, gender) {
  const all=await DB.getStudents();
  let students=all.filter(s=>{
    const streamOk=stream==='all'||s.stream===stream;
    const genderOk=gender==='all'||s.gender===gender;
    const searchOk=!q.trim()||(s.name.toLowerCase().includes(q.toLowerCase())||s.grade.toLowerCase().includes(q.toLowerCase())||s.stream.toLowerCase().includes(q.toLowerCase()));
    return streamOk&&genderOk&&searchOk;
  });
  const wrap=document.querySelector('.table-wrap'); if(wrap) wrap.innerHTML=renderStudentTableInner(students,false);
  const lbl=document.querySelector('.stream-showing-label'); if(lbl) lbl.innerHTML=(stream==='all'?'Showing all streams':'Stream: <strong>'+stream+'</strong>')+' &nbsp;·&nbsp; '+students.length+' student'+(students.length!==1?'s':'');
}

async function filterStudentTable(q) {
  const all=await DB.getStudents();
  const students=all.filter(s=>s.name.toLowerCase().includes(q.toLowerCase())||s.grade.toLowerCase().includes(q.toLowerCase())||s.stream.toLowerCase().includes(q.toLowerCase()));
  const wrap=document.querySelector('.table-wrap'); if(wrap) wrap.innerHTML=renderStudentTableInner(students,false);
}

function renderStudentTable(students,compact) { return `<div class="table-wrap">${renderStudentTableInner(students,compact)}</div>`; }

function renderStudentTableInner(students,compact) {
  if (!students.length) return '<div class="empty-state"><i class="fas fa-users-slash"></i><p>No students found.</p></div>';
  return `<table class="data-table"><thead><tr><th>Student</th><th>Grade / Stream</th><th>Gender</th><th>Pickers</th><th>Status</th>${!compact?'<th>Actions</th>':''}</tr></thead><tbody>
    ${students.map(s=>`<tr>
      <td><div class="student-cell">${s.photo?`<img src="${s.photo}" class="s-avatar-img" alt="${s.name}"/>`:`<div class="s-avatar">${initials(s.name)}</div>`}<div><div class="s-name">${s.name}</div><div class="s-school">${s.school}</div></div></div></td>
      <td><span class="text-sm">${s.grade}</span><br/><span class="text-muted">${s.stream}</span></td>
      <td>${s.gender?`<span class="gender-badge ${s.gender==='Male'?'gender-male':'gender-female'}"><i class="fas fa-${s.gender==='Male'?'mars':'venus'}"></i> ${s.gender}</span>`:'<span class="text-muted">—</span>'}</td>
      <td><span class="badge badge-blue">${(s.persons||[]).length}/${MAX_PERSONS}</span>${(s.persons||[]).length<MAX_PERSONS?`<span style="font-size:.7rem;color:var(--green);margin-left:4px"><i class="fas fa-plus-circle"></i> can add</span>`:`<span style="font-size:.7rem;color:var(--text-muted);margin-left:4px">full</span>`}</td>
      <td>${statusBadge(s.status)}</td>
      ${!compact?`<td><div class="action-btns">
        <button class="btn btn-icon btn-blue" title="View" onclick="viewStudent('${s.id}')"><i class="fas fa-eye"></i></button>
        <button class="btn btn-icon btn-green" title="Edit" onclick="editStudent('${s.id}')"><i class="fas fa-pen"></i></button>
        <button class="btn btn-icon btn-orange" title="Card" onclick="openCard('${s.id}')"><i class="fas fa-id-card"></i></button>
        <button class="btn btn-icon btn-red" title="Delete" onclick="promptDelete('${s.id}','${s.name.replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
      </div></td>`:''}
    </tr>`).join('')}</tbody></table>`;
}

async function renderPicked() {
  const all=await DB.getStudents();
  const todayStr=getTodayDateStr();
  const picked=all.filter(s=>s.lastPickedDate===todayStr);

  const cards = picked.length ? picked.map(s=>{
    const pickerName = s.pickedBy ? s.pickedBy.replace(/\s*\(.*\)$/,'') : '';
    const pickerRel  = s.pickedBy ? (s.pickedBy.match(/\(([^)]+)\)/)||[])[1]||'' : '';
    const pickerPerson = (s.persons||[]).find(p=>p.name===pickerName)||null;
    const pickerPhone = pickerPerson?.phone||'';
    const pickerPhoto = pickerPerson?.photo||'';
    return `<div class="picked-card">
      <div class="picked-card-child">
        ${s.photo?`<img src="${s.photo}" class="picked-child-photo" alt="${s.name}"/>`:`<div class="picked-child-ph">${initials(s.name)}</div>`}
        <div class="picked-child-info">
          <div class="picked-child-name">${s.name}</div>
          <div class="picked-child-meta">${s.grade} &nbsp;·&nbsp; ${s.stream}</div>
          <div class="picked-child-school"><i class="fas fa-school" style="font-size:.7rem"></i> ${s.school}</div>
        </div>
        <span class="badge badge-blue" style="margin-left:auto;align-self:flex-start"><i class="fas fa-circle-check"></i> Picked</span>
      </div>
      <div class="picked-card-divider"></div>
      <div class="picked-card-picker-label"><i class="fas fa-hand-holding-heart"></i> Picked by</div>
      <div class="picked-card-picker">
        ${pickerPhoto?`<img src="${pickerPhoto}" class="picked-picker-photo" alt="${pickerName}"/>`:`<div class="picked-picker-ph">${initials(pickerName)}</div>`}
        <div class="picked-picker-info">
          <div class="picked-picker-name">${pickerName||'—'}</div>
          <div class="picked-picker-rel">${pickerRel}</div>
          ${pickerPhone?`<div class="picked-picker-phone"><i class="fas fa-phone"></i> ${pickerPhone}</div>`:''}
        </div>
        <div class="picked-time"><i class="fas fa-clock"></i><span>${s.pickedAt||''}</span></div>
      </div>
    </div>`;
  }).join('') : '<div class="empty-state"><i class="fas fa-circle-check"></i><p>No children picked up today yet.</p></div>';

  document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-circle-check"></i> Picked Today (${picked.length})</div></div><div class="picked-cards-grid">${cards}</div></div>`;
}

function renderLogs() {
  const logs=DB.getLogs();
  document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-clock-rotate-left"></i> Activity Logs (${logs.length})</div><button class="btn btn-danger btn-sm" onclick="clearAllLogs()"><i class="fas fa-trash"></i> Clear</button></div><div class="log-list">${logs.length?logs.map(renderLogItem).join(''):'<div class="empty-state"><i class="fas fa-inbox"></i><p>No logs.</p></div>'}</div></div>`;
}
function clearAllLogs() { DB.setLogs([]); renderLogs(); }

async function renderStreams() {
  const students=await DB.getStudents();
  const streams=[...new Set(students.map(s=>s.stream).filter(Boolean))].sort();
  if (!streams.length) {
    document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-title" style="margin-bottom:16px"><i class="fas fa-layer-group"></i> Streams</div><div class="empty-state"><i class="fas fa-layer-group"></i><p>No streams found. Register students with stream names like East, West, North, South.</p></div></div>`;
    return;
  }
  const streamCards=streams.map(st=>{
    const group=students.filter(s=>s.stream===st);
    const inSchool=group.filter(s=>s.status==='IN_SCHOOL').length;
    const picked=group.filter(s=>s.status==='PICKED').length;
    const boys=group.filter(s=>s.gender==='Male').length;
    const girls=group.filter(s=>s.gender==='Female').length;
    const streamColors=['#1d3557','#457b9d','#2dc653','#e63946','#f4a261','#a8dadc','#6a4c93','#ff595e'];
    const color=streamColors[Math.abs(st.split('').reduce((a,c)=>a+c.charCodeAt(0),0))%streamColors.length];
    return `<div class="stream-card" style="border-top:4px solid ${color}">
      <div class="stream-card-header">
        <div class="stream-card-icon" style="background:${color}20;color:${color}"><i class="fas fa-users"></i></div>
        <div>
          <div class="stream-card-name">${st}</div>
          <div class="stream-card-total">${group.length} student${group.length!==1?'s':''}</div>
        </div>
      </div>
      <div class="stream-card-stats">
        <div class="stream-stat"><i class="fas fa-school" style="color:${color}"></i><span>${inSchool} in school</span></div>
        <div class="stream-stat"><i class="fas fa-circle-check" style="color:var(--green)"></i><span>${picked} picked</span></div>
        <div class="stream-stat"><i class="fas fa-mars" style="color:#457b9d"></i><span>${boys} boys</span></div>
        <div class="stream-stat"><i class="fas fa-venus" style="color:#e63946"></i><span>${girls} girls</span></div>
      </div>
      <div class="stream-card-mini-photos">
        ${group.slice(0,6).map(s=>s.photo?`<img src="${s.photo}" class="stream-mini-avatar" title="${s.name}"/>`:`<div class="stream-mini-avatar-ph" title="${s.name}">${initials(s.name)}</div>`).join('')}
        ${group.length>6?`<div class="stream-mini-more">+${group.length-6}</div>`:''}
      </div>
      <button class="btn btn-primary btn-sm stream-view-btn" onclick="renderStudents('${st.replace(/'/g,"\\'")}','all');_currentSection='students';document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.section==='students'));document.getElementById('breadcrumbSection').textContent='All Students'">
        <i class="fas fa-eye"></i> View ${st} Students
      </button>
    </div>`;
  }).join('');
  document.getElementById('mainContent').innerHTML=`
    <div class="panel">
      <div class="section-header">
        <div class="section-title"><i class="fas fa-layer-group"></i> Streams (${streams.length})</div>
        <button class="btn btn-secondary btn-sm" onclick="loadSection('students')"><i class="fas fa-list"></i> View All Students</button>
      </div>
      <div class="streams-overview-grid">${streamCards}</div>
    </div>`;
}
function renderLogItem(l) {
  const cls=l.type==='warn'?'log-warn':l.type==='ok'?'log-ok':'log-info', ic=l.type==='warn'?'fa-triangle-exclamation':l.type==='ok'?'fa-circle-check':'fa-circle-info';
  return `<div class="log-item ${cls}"><div class="log-icon"><i class="fas ${ic}"></i></div><div><div class="log-text">${l.msg}</div><div class="log-time">${l.time}</div></div></div>`;
}

function renderSearch() {
  document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-title mb-16" style="margin-bottom:16px"><i class="fas fa-magnifying-glass"></i> Search Student</div>
    <div class="search-bar-wrap" style="max-width:100%;margin-bottom:20px"><span class="search-icon"><i class="fas fa-magnifying-glass"></i></span><input type="text" id="globalSearch" placeholder="Type student name, grade or stream…" oninput="doSearch(this.value)"/></div>
    <div id="searchResults"><div class="empty-state"><i class="fas fa-magnifying-glass"></i><p>Start typing to search…</p></div></div></div>`;
  document.getElementById('globalSearch').focus();
}
async function doSearch(q) {
  const res=document.getElementById('searchResults');
  if (!q.trim()) { res.innerHTML='<div class="empty-state"><i class="fas fa-magnifying-glass"></i><p>Start typing…</p></div>'; return; }
  const all=await DB.getStudents(), found=all.filter(s=>s.name.toLowerCase().includes(q.toLowerCase())||s.grade.toLowerCase().includes(q.toLowerCase())||s.stream.toLowerCase().includes(q.toLowerCase())||s.parentName.toLowerCase().includes(q.toLowerCase()));
  res.innerHTML=found.length?renderStudentTable(found,false):'<div class="empty-state"><i class="fas fa-face-sad-tear"></i><p>No students matched.</p></div>';
}

async function renderQRManager() {
  const students=await DB.getStudents();
  document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-qrcode"></i> QR Code Manager</div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px">
      ${students.map(s=>`<div class="qrm-card">
        <div class="qrm-name">${s.name}</div>
        <div class="qrm-meta">${s.grade} &nbsp;|&nbsp; ${s.stream}</div>
        <div id="qrMini-${s.id}" class="qrm-qr-wrap"></div>
        <div style="margin-bottom:12px">${s.qrActive?'<span class="badge badge-green"><i class="fas fa-circle-check"></i> QR Active</span>':'<span class="badge badge-red"><i class="fas fa-ban"></i> QR Inactive</span>'}</div>
        <div class="qrm-actions">
          <button class="btn btn-blue btn-sm" onclick="viewQRModal('${s.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-primary btn-sm" onclick="openCard('${s.id}')"><i class="fas fa-id-card"></i> Card</button>
          <button class="btn btn-warning btn-sm" onclick="promptDeactivate('${s.id}')"><i class="fas fa-rotate"></i> Regen</button>
        </div>
      </div>`).join('')}
    </div></div>

    <!-- QR View Modal -->
    <div class="modal-overlay" id="qrViewOverlay" onclick="if(event.target===this)closeQRModal()" style="display:none">
      <div class="modal glass-modal" style="max-width:340px;text-align:center">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 id="qrModalTitle" style="font-size:1rem;font-weight:700;color:var(--blue)"></h3>
          <button class="btn btn-secondary btn-sm" onclick="closeQRModal()"><i class="fas fa-xmark"></i></button>
        </div>
        <div id="qrModalQR" style="display:flex;justify-content:center;margin-bottom:14px;padding:12px;background:#fff;border-radius:10px;box-shadow:var(--shadow)"></div>
        <div id="qrModalMeta" style="font-size:.8rem;color:var(--text-muted);margin-bottom:16px"></div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="btn btn-primary btn-sm" onclick="printQRCode()"><i class="fas fa-print"></i> Print QR</button>
          <button class="btn btn-secondary btn-sm" onclick="closeQRModal()">Close</button>
        </div>
      </div>
    </div>`;

  if (typeof QRCode!=='undefined') students.forEach(s=>{
    const el=document.getElementById('qrMini-'+s.id);
    if(el){ try{ new QRCode(el,{text:VERIFY_URL+'?id='+s.id+'&v='+s.qrVersion,width:110,height:110,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H}); }catch(e){} }
  });
}

let _qrModalStudentId = null;
async function viewQRModal(id) {
  const students=await DB.getStudents(), s=students.find(x=>x.id===id); if(!s) return;
  _qrModalStudentId = id;
  document.getElementById('qrModalTitle').textContent = s.name + ' — QR Code';
  document.getElementById('qrModalMeta').textContent = s.grade + ' · ' + s.stream + ' · v' + s.qrVersion;
  const qrDiv=document.getElementById('qrModalQR'); qrDiv.innerHTML='';
  if(typeof QRCode!=='undefined'){
    try{ new QRCode(qrDiv,{text:VERIFY_URL+'?id='+s.id+'&v='+s.qrVersion,width:220,height:220,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H}); }catch(e){}
  }
  document.getElementById('qrViewOverlay').style.display='flex';
}
function closeQRModal() { document.getElementById('qrViewOverlay').style.display='none'; _qrModalStudentId=null; }
function printQRCode() {
  const qrDiv=document.getElementById('qrModalQR');
  const title=document.getElementById('qrModalTitle').textContent;
  const meta=document.getElementById('qrModalMeta').textContent;
  const img=qrDiv.querySelector('img,canvas');
  let src='';
  if(img&&img.tagName==='CANVAS') src=img.toDataURL();
  else if(img&&img.tagName==='IMG') src=img.src;
  const win=window.open('','_blank','width=400,height=500');
  win.document.write(`<html><head><title>QR - ${title}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#fff} h3{font-size:14px;margin-bottom:4px;color:#1d3557} p{font-size:11px;color:#6b7a9d;margin-bottom:12px} img{width:200px;height:200px;border:1px solid #eee;padding:8px;border-radius:8px}</style></head><body><h3>${title}</h3><p>${meta}</p><img src="${src}" onload="window.print();window.close()"/></body></html>`);
  win.document.close();
}

function renderUnauthorized() {
  const list=DB.getUnauth();
  document.getElementById('mainContent').innerHTML=`<div class="panel"><div class="section-header"><div class="section-title"><i class="fas fa-triangle-exclamation"></i> Unauthorized Attempts (${list.length})</div>${list.length?`<button class="btn btn-danger btn-sm" onclick="clearUnauth()"><i class="fas fa-trash"></i> Clear</button>`:''}</div>
    ${list.length?`<div class="log-list">${list.map(u=>`<div class="log-item log-warn"><div class="log-icon"><i class="fas fa-ban"></i></div><div><div class="log-text">Unauthorized attempt for <b>${u.studentName}</b></div><div class="log-time">${u.time}</div></div></div>`).join('')}</div>`:'<div class="empty-state"><i class="fas fa-shield-halved"></i><p>No unauthorized attempts recorded.</p></div>'}</div>`;
}
function clearUnauth() { DB.setUnauth([]); renderUnauthorized(); }

// ============================================================
//  REGISTER / EDIT  (MAX 3 PICKERS)
// ============================================================
let _personCount=1;

function renderRegister(prefill) {
  _personCount=prefill?.persons?.length||1;
  const canAdd=_personCount<MAX_PERSONS;
  document.getElementById('mainContent').innerHTML=`
    <div class="form-card">
      <div class="section-title mb-16" style="margin-bottom:18px"><i class="fas fa-user-plus"></i> ${prefill?'Edit Student':'Register New Student'}</div>
      <form id="registerForm" onsubmit="submitRegister(event,'${prefill?.id||''}')">
        <div class="form-grid">
          <div class="form-row"><label>Child Full Name *</label><input type="text" id="regName" placeholder="e.g. Amara Okonkwo" value="${prefill?.name||''}" required/></div>
          <div class="form-row"><label>School Name *</label><input type="text" id="regSchool" placeholder="e.g. SafePass Academy" value="${prefill?.school||'SafePass Academy'}" required/></div>
          <div class="form-row"><label>Grade / Class *</label><input type="text" id="regGrade" placeholder="e.g. Grade 4" value="${prefill?.grade||''}" required/></div>
          <div class="form-row"><label>Stream *</label><input type="text" id="regStream" placeholder="e.g. East / West / North / South" value="${prefill?.stream||''}" required/></div>
          <div class="form-row"><label><i class="fas fa-venus-mars"></i> Gender *</label>
            <select id="regGender" required>
              <option value="">-- Select Gender --</option>
              <option value="Male" ${prefill?.gender==='Male'?'selected':''}>Male</option>
              <option value="Female" ${prefill?.gender==='Female'?'selected':''}>Female</option>
            </select>
          </div>
          <div class="form-row"><label>Parent / Guardian Name *</label><input type="text" id="regParentName" placeholder="e.g. Mrs. Grace Okonkwo" value="${prefill?.parentName||''}" required/></div>
          <div class="form-row"><label><i class="fas fa-camera text-blue"></i> Child Photo</label>${photoWidget({id:'childPhoto',label:'Child Photo',value:prefill?.photo||''})}</div>
          <div class="form-row"><label><i class="fas fa-camera text-blue"></i> Parent / Guardian Photo</label>${photoWidget({id:'parentPhoto',label:'Parent Photo',value:prefill?.parentPhoto||''})}</div>
        </div>
        <div class="persons-section">
          <div class="person-reg-title">
            <i class="fas fa-users text-blue"></i> Authorized Pickup Persons
            <span class="person-count-badge" id="personCountBadge">${_personCount}</span>
            <span class="person-max-badge">max ${MAX_PERSONS}</span>
            <small style="font-weight:400;color:var(--text-muted);margin-left:8px">1 required · up to ${MAX_PERSONS} total</small>
          </div>
          <div class="person-reg-grid" id="personGrid">
            ${buildPersonCards(prefill?.persons||[{id:genId(),name:'',relationship:'',phone:'',photo:''}])}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:14px" id="addPersonBtn"
            onclick="addPersonSlot()" ${!canAdd?'disabled style="opacity:.45;cursor:not-allowed"':''}>
            <i class="fas fa-plus"></i> Add Another Person ${!canAdd?'(max reached)':`(${MAX_PERSONS-_personCount} slot${MAX_PERSONS-_personCount!==1?'s':''} left)`}
          </button>
        </div>
        <div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap">
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> ${prefill?'Save Changes':'Register Student & Generate Card'}</button>
          <button type="button" class="btn btn-secondary" onclick="loadSection('students')">Cancel</button>
        </div>
      </form>
    </div>`;
}

function buildPersonCards(persons) { return persons.map((p,i)=>buildPersonCard(p,i)).join(''); }

function buildPersonCard(p,i) {
  return `<div class="person-reg-card" id="personCard-${p.id}">
    <div class="person-card-header">
      <h4><i class="fas fa-person"></i> Person ${i+1}</h4>
      ${i>0?`<button type="button" class="btn btn-icon btn-red" onclick="removePersonSlot('${p.id}')"><i class="fas fa-xmark"></i></button>`:'<span class="required-pill">Required</span>'}
    </div>
    <div class="form-row" style="margin-bottom:10px"><label>Full Name *</label><input type="text" id="pname-${p.id}" placeholder="Full name" value="${p.name||''}" required/></div>
    <div class="form-row" style="margin-bottom:10px"><label>Relationship *</label>
      <select id="prel-${p.id}" required><option value="">-- Select --</option>
        ${['Father','Mother','Brother','Sister','Uncle','Aunt','Grandfather','Grandmother','Guardian','Cousin','Neighbour','Driver','Other'].map(r=>`<option ${p.relationship===r?'selected':''}>${r}</option>`).join('')}
      </select></div>
    <div class="form-row" style="margin-bottom:12px"><label>Phone (optional)</label><input type="tel" id="pphone-${p.id}" placeholder="+256 700 000 000" value="${p.phone||''}"/></div>
    <div class="form-row"><label><i class="fas fa-camera text-blue"></i> Photo of Person</label>${photoWidget({id:'pphoto-'+p.id,label:'Photo of Person',value:p.photo||''})}</div>
  </div>`;
}

function addPersonSlot() {
  const current=document.querySelectorAll('.person-reg-card').length;
  if (current>=MAX_PERSONS) { showToast('error',`Maximum ${MAX_PERSONS} authorized persons allowed.`); return; }
  const newId=genId(); _personCount++;
  document.getElementById('personCountBadge').textContent=_personCount;
  const grid=document.getElementById('personGrid'), div=document.createElement('div');
  div.innerHTML=buildPersonCard({id:newId,name:'',relationship:'',phone:'',photo:''},current);
  grid.appendChild(div.firstElementChild);
  const addBtn=document.getElementById('addPersonBtn');
  if (addBtn) {
    const rem=MAX_PERSONS-_personCount;
    if (_personCount>=MAX_PERSONS) { addBtn.disabled=true; addBtn.style.opacity='.45'; addBtn.style.cursor='not-allowed'; addBtn.innerHTML='<i class="fas fa-plus"></i> Add Another Person (max reached)'; }
    else { addBtn.innerHTML=`<i class="fas fa-plus"></i> Add Another Person (${rem} slot${rem!==1?'s':''} left)`; }
  }
}

function removePersonSlot(pid) {
  document.getElementById('personCard-'+pid)?.remove();
  _personCount--;
  document.getElementById('personCountBadge').textContent=_personCount;
  document.querySelectorAll('.person-reg-card h4').forEach((h,i)=>{ h.innerHTML=`<i class="fas fa-person"></i> Person ${i+1}`; });
  const addBtn=document.getElementById('addPersonBtn');
  if (addBtn&&_personCount<MAX_PERSONS) { addBtn.disabled=false; addBtn.style.opacity=''; addBtn.style.cursor=''; const rem=MAX_PERSONS-_personCount; addBtn.innerHTML=`<i class="fas fa-plus"></i> Add Another Person (${rem} slot${rem!==1?'s':''} left)`; }
}

function collectPersons() {
  const cards=document.querySelectorAll('.person-reg-card'), persons=[]; let hasError=false;
  cards.forEach(card=>{ const pid=card.id.replace('personCard-',''), name=document.getElementById('pname-'+pid)?.value.trim()||'', rel=document.getElementById('prel-'+pid)?.value||'', phone=document.getElementById('pphone-'+pid)?.value.trim()||'', photo=getPhotoWidget('pphoto-'+pid);
    if (!name||!rel) hasError=true; persons.push({id:pid,name,relationship:rel,phone,photo}); });
  return {persons,hasError};
}

async function submitRegister(e,existingId) {
  e.preventDefault(); document.querySelectorAll('.reg-field-error').forEach(el=>el.remove());
  let hasError=false;
  function fieldErr(id,msg) { const el=document.getElementById(id); if(!el) return; const err=document.createElement('span'); err.className='reg-field-error'; err.style.cssText='color:#e63946;font-size:.75rem;font-weight:600;margin-top:3px;display:block'; err.textContent='⚠ '+msg; el.parentNode.appendChild(err); el.style.borderColor='#e63946'; hasError=true; }
  const name=document.getElementById('regName').value.trim(), school=document.getElementById('regSchool').value.trim(), grade=document.getElementById('regGrade').value.trim(), stream=document.getElementById('regStream').value.trim(), parentName=document.getElementById('regParentName').value.trim(), gender=document.getElementById('regGender').value;
  if (!name) fieldErr('regName','Child name is required'); if (!school) fieldErr('regSchool','School name is required'); if (!grade) fieldErr('regGrade','Grade is required'); if (!stream) fieldErr('regStream','Stream is required'); if (!gender) fieldErr('regGender','Gender is required'); if (!parentName) fieldErr('regParentName','Parent name is required');
  const {persons,hasError:pErr}=collectPersons();
  if (pErr) { hasError=true; showToast('error','Fill in name & relationship for all persons.'); }
  if (!persons.length) { hasError=true; showToast('error','At least 1 authorized person is required.'); }
  if (hasError) { document.querySelector('.reg-field-error')?.scrollIntoView({behavior:'smooth',block:'center'}); return; }
  const isEdit=!!existingId;
  const s={ id:isEdit?existingId:genId(), createdAt:Date.now(), name, school, grade, stream, gender, parentName, photo:getPhotoWidget('childPhoto'), parentPhoto:getPhotoWidget('parentPhoto'), status:'IN_SCHOOL', pickedAt:null, pickedBy:null, qrActive:true, qrVersion:1, persons };
  if (isEdit) { const exist=(await DB.getStudents()).find(x=>x.id===existingId)||{}; Object.assign(s,{createdAt:exist.createdAt,status:exist.status,pickedAt:exist.pickedAt,pickedBy:exist.pickedBy,qrActive:exist.qrActive,qrVersion:exist.qrVersion}); }
  const btn=document.querySelector('#registerForm [type="submit"]'); if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> Saving…';}
  await DB.saveStudent(s); addLog('ok',`${isEdit?'Updated':'Registered'} student: ${s.name}`); showToast('success',`${s.name} ${isEdit?'updated!':'registered! Opening card…'}`);
  if (!isEdit) { setTimeout(()=>openCard(s.id),700); } else { setTimeout(()=>loadSection('students'),500); }
}

async function editStudent(id) {
  const students=await DB.getStudents(), s=students.find(x=>x.id===id);
  if (!s) { showToast('error','Student not found.'); return; }
  renderRegister(s); const bc=document.getElementById('breadcrumbSection'); if(bc) bc.textContent='Edit Student';
}

async function viewStudent(id) {
  const students=await DB.getStudents(), s=students.find(x=>x.id===id); if (!s) return;
  const content=document.getElementById('viewStudentContent');
  content.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h3 style="font-size:1.15rem;font-weight:700;color:var(--blue)"><i class="fas fa-user"></i> ${s.name}</h3><button class="btn btn-secondary btn-sm" onclick="closeModal('viewStudentOverlay')"><i class="fas fa-xmark"></i></button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px">
      <div><div class="detail-lbl">School</div><div style="font-weight:600">${s.school}</div></div>
      <div><div class="detail-lbl">Grade / Stream</div><div style="font-weight:600">${s.grade} — ${s.stream}</div></div>
      <div><div class="detail-lbl">Parent</div><div style="font-weight:600">${s.parentName}</div></div>
      <div><div class="detail-lbl">Status</div>${statusBadge(s.status)}</div>
      ${s.pickedAt?`<div style="grid-column:1/-1"><div class="detail-lbl">Picked At</div><div style="font-weight:600">${s.pickedAt}${s.pickedBy?' — by '+s.pickedBy:''}</div></div>`:''}
    </div>
    <div style="font-size:.8rem;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px"><i class="fas fa-users"></i> Authorized Persons (${(s.persons||[]).length}/${MAX_PERSONS})</div>
    <div class="person-cards">${(s.persons||[]).map(p=>`<div class="person-card">${p.photo?`<img src="${p.photo}" class="person-img" alt="${p.name}"/>`:`<div class="person-img-placeholder">${initials(p.name)}</div>`}<div class="person-name">${p.name}</div><div class="person-rel">${p.relationship}</div>${p.phone?`<div class="person-phone"><i class="fas fa-phone"></i> ${p.phone}</div>`:''}<span class="verified-badge"><i class="fas fa-circle-check"></i> Authorized</span></div>`).join('')}</div>
    <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-green btn-sm" onclick="closeModal('viewStudentOverlay');editStudent('${s.id}')"><i class="fas fa-pen"></i> Edit</button>
      <button class="btn btn-primary btn-sm" onclick="openCard('${s.id}');closeModal('viewStudentOverlay')"><i class="fas fa-id-card"></i> View Card</button>
      <button class="btn btn-warning btn-sm" onclick="closeModal('viewStudentOverlay');promptDeactivate('${s.id}')"><i class="fas fa-rotate"></i> Regen QR</button>
    </div>
    ${(s.pickupHistory&&s.pickupHistory.length)?`
    <div style="margin-top:20px;border-top:1px solid var(--bg2);padding-top:16px">
      <div style="font-size:.8rem;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px"><i class="fas fa-clock-rotate-left"></i> Pickup History (${s.pickupHistory.length} records)</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto">
        ${s.pickupHistory.map(h=>`<div class="log-item log-ok"><div class="log-icon"><i class="fas fa-circle-check"></i></div><div><div class="log-text"><b>${h.pickedBy}</b>${h.pickerPhone?' · '+h.pickerPhone:''}</div><div class="log-time">${h.pickedAt}</div></div></div>`).join('')}
      </div>
    </div>`:''}`;

  openModal('viewStudentOverlay');
}

async function promptDelete(id,name) { document.getElementById('deleteStudentName').textContent=`Delete "${name}"? Cannot be undone.`; document.getElementById('confirmDeleteBtn').onclick=()=>deleteStudent(id); openModal('confirmDeleteOverlay'); }
async function deleteStudent(id) { await DB.deleteStudent(id); addLog('warn',`Student ${id} deleted.`); closeModal('confirmDeleteOverlay'); showToast('success','Student deleted.'); loadSection('students'); }
async function promptDeactivate(id) { const s=(await DB.getStudents()).find(x=>x.id===id); if(!s) return; document.getElementById('deactivateStudentName').textContent=`Deactivate QR for "${s.name}"?`; document.getElementById('confirmDeactivateBtn').onclick=()=>deactivateQR(id); openModal('deactivateQROverlay'); }
async function deactivateQR(id) { const students=await DB.getStudents(), s=students.find(x=>x.id===id); if(!s) return; s.qrVersion=(s.qrVersion||1)+1; await DB.saveStudent(s); addLog('warn',`QR regenerated for ${s.name}.`); closeModal('deactivateQROverlay'); showToast('success','New QR generated. Old QR is now invalid.'); loadSection('qrmanager'); }
function openCard(id) { localStorage.setItem('sp_pendingCard',id); const url=CARD_URL+'?id='+encodeURIComponent(id); const win=window.open(url,'_blank'); if(!win||win.closed||typeof win.closed==='undefined') window.location.href=url; }

// ============================================================
//  ADMIN USER MANAGEMENT
// ============================================================
function renderAdmins() {
  const all = AdminDB.getAll();
  const current = JSON.parse(sessionStorage.getItem('sp_user')||'{}');
  const isSuperAdmin = current.role === 'super-admin';

  const rows = all.map((a,i) => `
    <tr>
      <td><div class="student-cell">
        <div class="s-avatar" style="background:${a.role==='super-admin'?'linear-gradient(135deg,#e63946,#c1121f)':'linear-gradient(135deg,#1d3557,#457b9d)'}">
          <i class="fas fa-${a.role==='super-admin'?'user-shield':'user'}"></i>
        </div>
        <div><div class="s-name">${a.fullName}</div><div class="s-school">@${a.username}</div></div>
      </div></td>
      <td><span class="badge ${a.role==='super-admin'?'badge-red':'badge-blue'}">${a.role==='super-admin'?'Super Admin':'Admin'}</span></td>
      <td><span class="text-muted text-sm">${a.createdAt?new Date(a.createdAt).toLocaleDateString('en-GB'):'—'}</span></td>
      <td>
        ${isSuperAdmin && a.username !== current.username
          ? `<button class="btn btn-icon btn-red" title="Remove" onclick="removeAdmin('${a.username}','${a.fullName.replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>`
          : a.username===current.username ? '<span class="text-muted text-sm">You</span>' : '—'}
      </td>
    </tr>`).join('');

  document.getElementById('mainContent').innerHTML=`
    <div class="panel">
      <div class="section-header">
        <div class="section-title"><i class="fas fa-users-gear"></i> Admin Users (${all.length})</div>
        ${isSuperAdmin?`<button class="btn btn-primary btn-sm" onclick="showAddAdminForm()"><i class="fas fa-user-plus"></i> Add Admin</button>`:''}
      </div>
      ${!isSuperAdmin?`<div class="admin-info-note"><i class="fas fa-circle-info"></i> Only the Super Admin can add or remove admin accounts.</div>`:''}
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>User</th><th>Role</th><th>Created</th><th>Action</th></tr></thead>
          <tbody>${rows||'<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">No admins yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div id="addAdminFormWrap"></div>
    </div>`;
}

function showAddAdminForm() {
  document.getElementById('addAdminFormWrap').innerHTML=`
    <div class="panel" style="margin-top:20px;border:1.5px solid var(--blue-light)">
      <div class="section-title" style="margin-bottom:16px"><i class="fas fa-user-plus"></i> Add New Admin</div>
      <div class="form-grid">
        <div class="form-row"><label>Full Name *</label><input type="text" id="newAdminName" placeholder="e.g. Mary Nakato"/></div>
        <div class="form-row"><label>Username *</label><input type="text" id="newAdminUser" placeholder="e.g. mary2026"/></div>
        <div class="form-row"><label>Password *</label><input type="password" id="newAdminPass" placeholder="Min 6 characters"/></div>
        <div class="form-row"><label>Role</label>
          <select id="newAdminRole">
            <option value="admin">Admin</option>
            <option value="super-admin">Super Admin</option>
          </select>
        </div>
      </div>
      <div class="login-error" id="addAdminErr" style="display:none;margin:10px 0"><i class="fas fa-triangle-exclamation"></i> <span id="addAdminErrMsg"></span></div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn btn-primary btn-sm" onclick="submitAddAdmin()"><i class="fas fa-save"></i> Create Admin</button>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('addAdminFormWrap').innerHTML=''">Cancel</button>
      </div>
    </div>`;
}

function submitAddAdmin() {
  const fullName=document.getElementById('newAdminName').value.trim(),
        username=document.getElementById('newAdminUser').value.trim(),
        password=document.getElementById('newAdminPass').value,
        role=document.getElementById('newAdminRole').value;
  const errEl=document.getElementById('addAdminErr'), errMsg=document.getElementById('addAdminErrMsg');
  function showErr(m){errMsg.textContent=m;errEl.style.display='flex';}
  if(!fullName){showErr('Full name is required.');return;}
  if(!username||username.length<3){showErr('Username must be at least 3 characters.');return;}
  if(!/^[a-zA-Z0-9_]+$/.test(username)){showErr('Username: letters, numbers and underscores only.');return;}
  if(password.length<6){showErr('Password must be at least 6 characters.');return;}
  if(AdminDB.find(username)){showErr('That username is already taken.');return;}
  AdminDB.save({username,fullName,password,role,createdAt:Date.now()});
  addLog('ok',`New admin "${fullName}" (@${username}) added.`);
  showToast('success',`${fullName} added as ${role}.`);
  renderAdmins();
}

function removeAdmin(username, fullName) {
  const current = JSON.parse(sessionStorage.getItem('sp_user')||'{}');
  if(username===current.username){showToast('error','You cannot remove your own account.');return;}
  if(confirm(`Remove admin "${fullName}" (@${username})? They will no longer be able to log in.`)){
    AdminDB.delete(username);
    addLog('warn',`Admin "${fullName}" (@${username}) removed.`);
    showToast('success',`${fullName} removed.`);
    renderAdmins();
  }
}
async function initCardPage() {
  seedDemoData(); await initFirebase();
  const params=new URLSearchParams(window.location.search);
  const id=params.get('id')||localStorage.getItem('sp_pendingCard')||null;
  if(id) localStorage.removeItem('sp_pendingCard');
  const wrap=document.getElementById('cardPageWrap');
  if (!id) { wrap.innerHTML='<div class="not-found-card"><div class="nf-icon"><i class="fas fa-ban"></i></div><h2>No student ID provided.</h2></div>'; return; }
  const students=await DB.getStudents(), s=students.find(x=>x.id===id);
  if (!s) { wrap.innerHTML='<div class="not-found-card"><div class="nf-icon"><i class="fas fa-face-sad-tear"></i></div><h2>Student not found.</h2></div>'; return; }
  const qrData=VERIFY_URL+'?id='+s.id+'&v='+s.qrVersion;
  // get parent contact from first person on list if available
  const parentContact = (s.persons&&s.persons[0]&&s.persons[0].phone) ? s.persons[0].phone : '';

  wrap.innerHTML=`<div class="card-controls"><h2><i class="fas fa-id-card"></i> ID Card — ${s.name}</h2><button class="btn btn-primary btn-sm" onclick="window.print()"><i class="fas fa-print"></i> Print</button><button class="btn btn-secondary btn-sm" onclick="window.close()"><i class="fas fa-xmark"></i> Close</button></div>
    <div class="id-card-pair">
      <!-- FRONT -->
      <div><div class="card-face-label">FRONT</div><div class="id-card id-card-front">
        <div class="cf-header">
          <div class="cf-logo cf-logo-badge"><img src="assets/logo.png" alt="Badge" class="cf-badge-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><span class="cf-badge-fallback"><i class="fas fa-shield-halved"></i></span></div>
          <div class="cf-school-info"><h3>${s.school}</h3><p>Student Pickup Identification Card</p></div>
        </div>
        <div class="cf-strip">🔒 OFFICIAL STUDENT PICKUP CARD</div>
        <div class="cf-body">
          <div class="cf-photo-col">
            ${s.photo?`<img src="${s.photo}" class="cf-child-photo" alt="${s.name}"/>`:`<div class="cf-child-photo-ph"><i class="fas fa-user"></i></div>`}
            <div class="cf-parent-block">
              <div class="cf-parent-block-label">Parent</div>
              ${s.parentPhoto?`<img src="${s.parentPhoto}" class="cf-parent-mini-photo" alt="Parent"/>`:`<div class="cf-parent-mini-ph"><i class="fas fa-person" style="font-size:.55rem"></i></div>`}
            </div>
          </div>
          <div class="cf-info">
            <div class="cf-name">${s.name}</div>
            <div class="cf-divider-line"></div>
            <div class="cf-row"><span class="cf-lbl">Class</span><span class="cf-val">${s.grade}</span></div>
            <div class="cf-row"><span class="cf-lbl">Stream</span><span class="cf-val">${s.stream}</span></div>
            ${s.gender?`<div class="cf-row"><span class="cf-lbl">Gender</span><span class="cf-val cf-gender-val ${s.gender==='Male'?'cf-gender-male':'cf-gender-female'}"><i class="fas fa-${s.gender==='Male'?'mars':'venus'}" style="font-size:6px"></i> ${s.gender}</span></div>`:''}
            <div class="cf-row"><span class="cf-lbl">Guardian</span><span class="cf-val">${s.parentName}</span></div>
            ${parentContact?`<div class="cf-row"><span class="cf-lbl">Contact</span><span class="cf-val cf-contact-val"><i class="fas fa-phone" style="font-size:6px"></i> ${parentContact}</span></div>`:''}
            <div class="cf-scan-hint"><i class="fas fa-qrcode"></i> Scan back to verify pickup</div>
          </div>
        </div>
        <div class="cf-footer">SafePass © 2026 &nbsp;|&nbsp; ${s.school}</div>
      </div></div>

      <!-- BACK: QR only + if-found in green -->
      <div><div class="card-face-label">BACK</div><div class="id-card id-card-back">
        <div class="cb-body-new">
          <div class="cb-back-child-row">
            ${s.photo?`<img src="${s.photo}" class="cb-back-child-photo" alt="${s.name}"/>`:`<div class="cb-back-child-ph">${initials(s.name)}</div>`}
            <div class="cb-back-child-info">
              <div class="cb-back-name">${s.name}</div>
              <div class="cb-back-grade">${s.grade} &nbsp;·&nbsp; ${s.stream}</div>
            </div>
          </div>
          <div class="cb-qr-wrap">
            <div class="cb-qr-main" id="cardQRDiv"></div>
          </div>
          <div class="cb-found-section">
            <div class="cb-found-label"><i class="fas fa-map-marker-alt"></i> If found, return to:</div>
            <div class="cb-found-school">${s.school}</div>
            <div class="cb-found-contacts">
              <div class="cb-found-contact"><i class="fas fa-envelope"></i> ssebayiggajovan9@gmail.com</div>
              <div class="cb-found-contact"><i class="fas fa-phone"></i> 0742590000</div>
            </div>
          </div>
        </div>
        <div class="cb-footer">v${s.qrVersion} &nbsp;|&nbsp; ${s.school}</div>
      </div></div>
    </div>`;
  setTimeout(()=>{ const qrDiv=document.getElementById('cardQRDiv'); if(qrDiv&&typeof QRCode!=='undefined'){ try{ new QRCode(qrDiv,{text:qrData,width:160,height:160,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H}); }catch(e){} } },300);
}

// ============================================================
//  VERIFY PAGE  –  QR SCANNER + PICKER SELECTION
// ============================================================
let _scannerStream=null, _scannerActive=false, _scanInterval=null, _selectedPickerId=null;

async function initVerifyPage() {
  seedDemoData();
  await initFirebase();
  await runDailyResetIfNeeded();
  startLiveStudentsListener(null);

  // Block scanning on non-school days
  const dayStatus = getSchoolDayStatus();
  if (!dayStatus.allowed) {
    const pill=document.getElementById('verifyStatusPill');
    if(pill){ pill.innerHTML='<i class="fas fa-calendar-xmark"></i> No School Today'; pill.style.background='rgba(230,57,70,.2)'; }
    document.getElementById('verifyContent').innerHTML=`
      <div class="school-closed-card">
        <div class="sc-icon"><i class="fas fa-calendar-xmark"></i></div>
        <h2>No Scanning Today</h2>
        <p class="sc-reason">${dayStatus.reason}</p>
        <p class="sc-note">QR scanning is only available on school days (Monday – Friday, excluding public holidays).</p>
        <div class="sc-next">Next school day scanning will resume automatically.</div>
      </div>`;
    return;
  }

  const params=new URLSearchParams(window.location.search), id=params.get('id'), v=params.get('v');
  if (id&&v!==null) { loadStudentVerify(id,parseInt(v)); }
  else { showScannerUI(); }
}

function showScannerUI() {
  const pill=document.getElementById('verifyStatusPill');
  if(pill){ pill.innerHTML='<i class="fas fa-qrcode"></i> Ready to Scan'; pill.style.background='rgba(69,123,157,.25)'; }
  document.getElementById('verifyContent').innerHTML=`
    <div class="scanner-card">
      <div class="scanner-hero">
        <div class="scanner-icon-wrap"><i class="fas fa-qrcode"></i></div>
        <h2>Scan Student QR Card</h2>
        <p>Point the camera at the QR code on the student's card to instantly load their pickup information.</p>
      </div>
      <div class="scanner-viewport" id="scannerViewport" style="display:none">
        <video id="scannerVideo" autoplay playsinline muted></video>
        <canvas id="scannerCanvas" style="display:none"></canvas>
        <div class="scan-line"></div>
        <div class="scan-corner tl"></div><div class="scan-corner tr"></div>
        <div class="scan-corner bl"></div><div class="scan-corner br"></div>
        <div class="scan-hint-overlay">Point at the QR code on the card</div>
      </div>
      <div id="scannerStatus" class="scanner-status-msg" style="display:none"></div>
      <div class="scanner-btn-row">
        <button class="btn-scan-start" id="scanStartBtn" onclick="startQRScanner()">
          <i class="fas fa-camera"></i> Scan QR Code to Release Child
        </button>
        <button class="btn btn-secondary" id="scanStopBtn" style="display:none" onclick="stopQRScanner()">
          <i class="fas fa-xmark"></i> Cancel Scan
        </button>
      </div>
      <div class="scanner-manual">
        <span>Or enter student ID manually:</span>
        <div class="scanner-manual-row">
          <input type="text" id="manualIdInput" placeholder="Student ID  e.g. SP-XXXXXX-XXXXX"/>
          <button class="btn btn-primary btn-sm" onclick="lookupManualId()"><i class="fas fa-magnifying-glass"></i> Lookup</button>
        </div>
      </div>
    </div>`;
}

async function startQRScanner() {
  _scannerActive=true;
  const viewport=document.getElementById('scannerViewport'), startBtn=document.getElementById('scanStartBtn'), stopBtn=document.getElementById('scanStopBtn'), statusEl=document.getElementById('scannerStatus');
  startBtn.style.display='none'; stopBtn.style.display='inline-flex'; viewport.style.display='block'; statusEl.style.display='flex'; statusEl.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> Starting camera…';
  try {
    _scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}}});
    const video=document.getElementById('scannerVideo'); video.srcObject=_scannerStream; await video.play();
    statusEl.innerHTML='<i class="fas fa-spinner fa-spin"></i> Scanning for QR code…';
    await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js');
    _scanInterval=setInterval(()=>{
      if (!_scannerActive) return;
      const video=document.getElementById('scannerVideo'), canvas=document.getElementById('scannerCanvas');
      if (!video||!canvas||video.readyState<2) return;
      canvas.width=video.videoWidth; canvas.height=video.videoHeight;
      const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0);
      const imgData=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=jsQR(imgData.data,imgData.width,imgData.height,{inversionAttempts:'dontInvert'});
      if (code&&code.data) {
        try {
          const parsed=new URL(code.data), qrId=parsed.searchParams.get('id'), qrV=parseInt(parsed.searchParams.get('v')||'1');
          if (qrId) { stopQRScanner(); statusEl.style.display='flex'; statusEl.innerHTML='<i class="fas fa-circle-check" style="color:var(--green)"></i> QR detected! Loading student…'; setTimeout(()=>loadStudentVerify(qrId,qrV),400); return; }
        } catch(e){}
        statusEl.innerHTML='<i class="fas fa-triangle-exclamation" style="color:var(--orange)"></i> QR found but not a SafePass card. Try again.';
      }
    },250);
  } catch(err) {
    statusEl.innerHTML='<i class="fas fa-ban" style="color:var(--red)"></i> Camera denied. Use manual ID below.';
    startBtn.style.display='flex'; stopBtn.style.display='none'; _scannerActive=false;
  }
}

function stopQRScanner() {
  _scannerActive=false;
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval=null; }
  if (_scannerStream) { _scannerStream.getTracks().forEach(t=>t.stop()); _scannerStream=null; }
  const viewport=document.getElementById('scannerViewport'), startBtn=document.getElementById('scanStartBtn'), stopBtn=document.getElementById('scanStopBtn');
  if(viewport) viewport.style.display='none'; if(startBtn) startBtn.style.display='flex'; if(stopBtn) stopBtn.style.display='none';
}

async function lookupManualId() {
  const input=document.getElementById('manualIdInput'), rawId=(input?.value||'').trim();
  if (!rawId) { showToast('error','Please enter a student ID.'); return; }
  const statusEl=document.getElementById('scannerStatus');
  if(statusEl){ statusEl.style.display='flex'; statusEl.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> Looking up…'; }
  let id=rawId, v=1;
  try { const u=new URL(rawId); id=u.searchParams.get('id')||rawId; v=parseInt(u.searchParams.get('v')||'1'); } catch(e){}
  await loadStudentVerify(id,v);
}

async function loadStudentVerify(id, version) {
  const content=document.getElementById('verifyContent'), pill=document.getElementById('verifyStatusPill');
  content.innerHTML='<div class="verify-loading"><i class="fas fa-circle-notch fa-spin fa-2x"></i><p>Loading student record…</p></div>';
  const students=await DB.getStudents(), s=students.find(x=>x.id===id);
  if (!s) { showQRInvalid('Student record not found.'); return; }
  if (!s.qrActive||s.qrVersion!==version) { showQRDeactivated(s.name); return; }

  // Use date-based eligibility — preserves all history
  const eligibleToday = isEligibleToday(s);
  if(pill){ if(eligibleToday){ pill.innerHTML='<i class="fas fa-circle" style="font-size:.5rem;color:#2dc653"></i> IN SCHOOL'; pill.style.background='rgba(45,198,83,.18)'; } else { pill.innerHTML='<i class="fas fa-circle" style="font-size:.5rem;color:#90caf9"></i> PICKED TODAY'; pill.style.background='rgba(69,123,157,.25)'; } }
  addLog('info',`QR scanned for student: ${s.name}`);
  _selectedPickerId=null;
  window._verifyStudent=s;

  const readOnlyPersons=(s.persons||[]).map(p=>`<div class="auth-person-tile">${p.photo?`<img src="${p.photo}" alt="${p.name}"/>`:`<div class="auth-ph">${initials(p.name)}</div>`}<div class="auth-name">${p.name}</div><div class="auth-rel">${p.relationship}</div>${p.phone?`<div class="auth-phone"><i class="fas fa-phone"></i> ${p.phone}</div>`:''}<span class="verified-badge"><i class="fas fa-circle-check"></i> Authorized</span></div>`).join('');

  const clickablePersons=(s.persons||[]).map(p=>`
    <div class="auth-person-tile picker-selectable" id="picker-tile-${p.id}"
         onclick="selectPicker('${s.id}','${p.id}')" role="button" tabindex="0">
      <div class="picker-select-ring" id="picker-ring-${p.id}">
        <i class="fas fa-circle-check picker-check-icon" id="picker-check-${p.id}"></i>
        ${p.photo?`<img src="${p.photo}" alt="${p.name}"/>`:`<div class="auth-ph">${initials(p.name)}</div>`}
      </div>
      <div class="auth-name">${p.name}</div>
      <div class="auth-rel">${p.relationship}</div>
      ${p.phone?`<div class="auth-phone"><i class="fas fa-phone"></i> ${p.phone}</div>`:''}
      <span class="verified-badge"><i class="fas fa-circle-check"></i> Authorized</span>
      <div class="picker-tap-hint">Tap to select</div>
    </div>`).join('');

  content.innerHTML=`<div class="child-info-card">
    <div class="child-card-header">
      <div style="font-size:.78rem;color:rgba(255,255,255,.8);font-weight:600;letter-spacing:.5px;text-transform:uppercase">${s.school}</div>
      <h2>${s.name}</h2><p>${s.grade} &nbsp;|&nbsp; ${s.stream}</p>
      <div class="child-photo-wrap">${s.photo?`<img src="${s.photo}" alt="${s.name}"/>`:`<div class="child-photo-placeholder"><i class="fas fa-user"></i></div>`}</div>
    </div>
    <div class="child-card-body">
      <div class="child-detail-grid">
        <div class="child-detail-item"><div class="lbl">Grade</div><div class="val">${s.grade}</div></div>
        <div class="child-detail-item"><div class="lbl">Stream</div><div class="val">${s.stream}</div></div>
        <div class="child-detail-item"><div class="lbl">School</div><div class="val">${s.school}</div></div>
        <div class="child-detail-item"><div class="lbl">Student ID</div><div class="val" style="font-size:.75rem;word-break:break-all">${s.id.substr(0,16)}…</div></div>
      </div>
      <div class="status-banner ${eligibleToday?'in-school':'picked'}">
        ${eligibleToday?'<i class="fas fa-school"></i> CURRENTLY IN SCHOOL':'<i class="fas fa-circle-check"></i> ALREADY PICKED UP TODAY'}
      </div>
      ${!eligibleToday&&s.pickedAt?`<div class="picked-info-banner"><i class="fas fa-clock"></i> Last picked: ${s.pickedAt}${s.pickedBy?` &nbsp;·&nbsp; <i class="fas fa-person"></i> By: <b>${s.pickedBy}</b>`:''}</div>`:''}
      <div class="auth-section-title"><i class="fas fa-person"></i> Parent / Guardian</div>
      <div class="parent-row">${s.parentPhoto?`<img src="${s.parentPhoto}" class="parent-photo" alt="Parent"/>`:`<div class="parent-photo-ph"><i class="fas fa-person"></i></div>`}<div class="parent-info"><div class="parent-label">Parent Name</div><div class="parent-name">${s.parentName}</div></div></div>

      ${eligibleToday?`
        <div class="auth-section-title"><i class="fas fa-users"></i> Tap the person who came to pick up <span class="badge badge-blue" style="margin-left:8px">${(s.persons||[]).length}</span></div>
        <div class="picker-instruction-banner"><i class="fas fa-hand-pointer"></i><span>Tap their photo below to approve departure</span></div>
        <div class="auth-persons-grid" id="pickersGrid">${clickablePersons}</div>
        <div class="selected-picker-bar" id="selectedPickerBar" style="display:none">
          <div class="selected-picker-info" id="selectedPickerInfo"></div>
          <button class="btn-confirm-depart" onclick="confirmDeparture('${s.id}')"><i class="fas fa-hand-holding-heart"></i> Confirm Departure</button>
          <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%" onclick="clearPickerSelection()"><i class="fas fa-rotate-left"></i> Change selection</button>
        </div>
        <button class="btn-unauth" onclick="showUnauthorized('${s.id}','${s.name.replace(/'/g,"\\'")}')"><i class="fas fa-ban"></i> Person NOT on the list</button>
      `:`
        <div class="auth-section-title"><i class="fas fa-users"></i> Authorized Pickup Persons <span class="badge badge-blue" style="margin-left:8px">${(s.persons||[]).length}</span></div>
        <div class="auth-persons-grid">${readOnlyPersons}</div>
        <button class="btn-pickup-confirm" disabled><i class="fas fa-lock"></i> Already Picked Up Today</button>
      `}
      <button class="btn-scan-again" onclick="showScannerUI()"><i class="fas fa-qrcode"></i> Scan Another Card</button>
    </div>
  </div>`;
}

function selectPicker(studentId, personId) {
  _selectedPickerId=personId;
  const s=window._verifyStudent; if (!s) return;
  document.querySelectorAll('.auth-person-tile.picker-selectable').forEach(t=>t.classList.remove('picker-selected'));
  document.getElementById('picker-tile-'+personId)?.classList.add('picker-selected');
  const person=(s.persons||[]).find(p=>p.id===personId); if (!person) return;
  const bar=document.getElementById('selectedPickerBar'), info=document.getElementById('selectedPickerInfo');
  if(info) info.innerHTML=`
    <div class="spb-photo">${person.photo?`<img src="${person.photo}" alt="${person.name}"/>`:`<div class="spb-initials">${initials(person.name)}</div>`}</div>
    <div class="spb-details"><div class="spb-name">${person.name}</div><div class="spb-rel">${person.relationship}</div><div class="spb-label">Selected as today's pickup person</div></div>`;
  if(bar){ bar.style.display='flex'; setTimeout(()=>bar.scrollIntoView({behavior:'smooth',block:'nearest'}),100); }
}

function clearPickerSelection() {
  _selectedPickerId=null;
  document.querySelectorAll('.auth-person-tile.picker-selectable').forEach(t=>t.classList.remove('picker-selected'));
  const bar=document.getElementById('selectedPickerBar'); if(bar) bar.style.display='none';
}

async function confirmDeparture(studentId) {
  if (!_selectedPickerId) { showToast('error','Please tap a pickup person first.'); return; }
  const students=await DB.getStudents(), s=students.find(x=>x.id===studentId); if (!s) return;
  const person=(s.persons||[]).find(p=>p.id===_selectedPickerId); if (!person) return;

  // Preserve full history — never overwrite old records, just append today's pickup
  s.status='PICKED';
  s.pickedAt=nowStr();
  s.pickedBy=person.name+' ('+person.relationship+')';
  s.lastPickedDate=getTodayDateStr(); // marks as picked today — resets eligibility for today
  // Append to pickup history for full audit trail
  if (!s.pickupHistory) s.pickupHistory=[];
  s.pickupHistory.unshift({ date:getTodayDateStr(), pickedAt:s.pickedAt, pickedBy:s.pickedBy, pickerPhone:person.phone||'' });
  if (s.pickupHistory.length>365) s.pickupHistory.pop(); // keep up to 1 year

  await DB.saveStudent(s); addLog('ok',`${s.name} picked up by ${s.pickedBy} at ${s.pickedAt}.`);

  document.getElementById('verifyContent').innerHTML=`
    <div class="departure-success-card">
      <div class="ds-icon"><i class="fas fa-circle-check"></i></div>
      <h2>Departure Confirmed!</h2>
      <div class="ds-child">
        ${s.photo?`<img src="${s.photo}" alt="${s.name}"/>`:`<div class="ds-child-ph"><i class="fas fa-user"></i></div>`}
        <div class="ds-child-name">${s.name}</div>
        <div class="ds-child-grade">${s.grade} · ${s.stream}</div>
      </div>
      <div class="ds-divider"></div>
      <div class="ds-picker-row">
        <div class="ds-picker-label">Released to</div>
        <div class="ds-picker-box">
          ${person.photo?`<img src="${person.photo}" alt="${person.name}" class="ds-picker-img"/>`:`<div class="ds-picker-ph">${initials(person.name)}</div>`}
          <div><div class="ds-picker-name">${person.name}</div><div class="ds-picker-rel">${person.relationship}</div></div>
        </div>
      </div>
      <div class="ds-time"><i class="fas fa-clock"></i> ${s.pickedAt}</div>
      <div class="ds-log-note"><i class="fas fa-shield-halved"></i> This pickup has been logged and recorded.</div>
      <button class="btn-scan-again" style="margin-top:20px" onclick="showScannerUI()"><i class="fas fa-qrcode"></i> Scan Another Card</button>
    </div>`;

  const pill=document.getElementById('verifyStatusPill');
  if(pill){ pill.innerHTML='<i class="fas fa-circle-check" style="color:var(--green)"></i> DEPARTED'; pill.style.background='rgba(45,198,83,.2)'; }
  _selectedPickerId=null;
}

function showQRInvalid(msg) {
  document.getElementById('verifyContent').innerHTML=`<div class="qr-invalid-card"><div class="nf-icon" style="font-size:3rem;color:var(--red);margin-bottom:16px"><i class="fas fa-ban"></i></div><h2 style="font-size:1.2rem;font-weight:700;color:var(--red);margin-bottom:8px">Invalid QR Code</h2><p style="color:var(--text-muted)">${msg}</p><button class="btn-scan-again" style="margin-top:20px" onclick="showScannerUI()"><i class="fas fa-rotate-left"></i> Try Again</button></div>`;
  const pill=document.getElementById('verifyStatusPill'); if(pill){ pill.innerHTML='<i class="fas fa-xmark"></i> Invalid'; pill.style.background='rgba(230,57,70,.25)'; }
}
function showQRDeactivated(name) {
  document.getElementById('verifyContent').innerHTML=`<div class="qr-invalid-card"><div class="nf-icon" style="font-size:3rem;color:var(--red);margin-bottom:16px"><i class="fas fa-qrcode"></i></div><h2 style="font-size:1.2rem;font-weight:700;color:var(--red);margin-bottom:8px">QR Code Deactivated</h2><p style="color:var(--text-muted)">This QR for <b>${name}</b> has been deactivated. Contact school for a new card.</p><button class="btn-scan-again" style="margin-top:20px" onclick="showScannerUI()"><i class="fas fa-rotate-left"></i> Scan Again</button></div>`;
  const pill=document.getElementById('verifyStatusPill'); if(pill){ pill.innerHTML='<i class="fas fa-ban"></i> Deactivated'; pill.style.background='rgba(230,57,70,.25)'; }
}
function showUnauthorized(id,name) {
  const unauth=DB.getUnauth(); unauth.unshift({studentId:id,studentName:name,time:nowStr(),date:today()}); DB.setUnauth(unauth);
  addLog('warn',`Unauthorized pickup attempt for ${name}.`);
  document.getElementById('unauthorizedMsg').textContent=`The person presenting this card is NOT among the authorized pickup persons for ${name}. The child must NOT be released.`;
  document.getElementById('unauthorizedTimestamp').textContent='⏱ Attempt logged at: '+nowStr();
  document.getElementById('unauthorizedOverlay').style.display='flex';
}
function closeUnauthorized() { document.getElementById('unauthorizedOverlay').style.display='none'; }


