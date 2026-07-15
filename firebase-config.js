/* =========================================================================
   FIREBASE CONFIG — fill this in with your own project's values.
   See README.md for step-by-step setup instructions (takes about 5 minutes,
   free tier is plenty for a classroom).
   ========================================================================= */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();