# Classroom Hub — setup guide

This app has two pages:

- `teacher.html` — create a class, post assignments and announcements, view submissions.
- `student.html` — join a class with a code, view assignments, submit work, view announcements.

They stay in sync **across any device** in real time, using a free Firebase database as the backend. Takes about 5 minutes to set up, one time only.

## 1. Create a free Firebase project

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Click **Add project**, give it any name (e.g. "classroom-hub"), and finish the wizard (you can skip Google Analytics).
3. In the left sidebar, click **Build → Firestore Database → Create database**. Choose any region, and start in **test mode** (fine for a classroom tool — see the security note below).
4. In the left sidebar, click the gear icon → **Project settings**. Scroll to "Your apps," click the `</>` (web) icon, register an app (any nickname), and skip hosting setup.
5. Firebase will show you a `firebaseConfig` object with values like `apiKey`, `authDomain`, `projectId`, etc.

## 2. Plug your config into the app

Open `firebase-config.js` and replace the placeholder values with the ones Firebase gave you:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "classroom-hub-xxxxx.firebaseapp.com",
  projectId: "classroom-hub-xxxxx",
  storageBucket: "classroom-hub-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

Save the file. That's it — all three files (`teacher.html`, `student.html`, `firebase-config.js`, `styles.css`, `teacher.js`, `student.js`) read from the same config.

## 3. Host it (so it works from any device)

Any static host works, for example:

- **GitHub Pages**: push this folder to a GitHub repo, enable Pages in repo settings.
- **Netlify / Vercel**: drag-and-drop the folder onto their web dashboard.
- **A school web server**: just upload the files.

Once hosted, share:
- `yoursite.com/teacher.html` with the teacher
- `yoursite.com/student.html` with students

You can also open both files directly from disk to test locally, but a couple of browsers restrict Firestore over `file://` — hosting (even Netlify's free drag-and-drop) avoids that entirely.

## 4. How it works day to day

1. Teacher opens `teacher.html`, fills in class name + their name → gets a 6-character join code.
2. Students open `student.html`, enter that code + their name → they're in.
3. Anything the teacher posts (assignment, announcement) appears on every student's device within a second or two, and any student submission appears on the teacher's device the same way — no refresh needed.
4. Each device remembers who it is (via the browser's local storage), so reopening the page skips straight back into the class.

## Security note

Firestore's "test mode" allows open read/write for 30 days, which is fine for trying this out. For real classroom use, tighten the rules in Firebase Console → Firestore → Rules, for example to require a name field before writing. Ask me and I can write locked-down rules for this exact data structure.
