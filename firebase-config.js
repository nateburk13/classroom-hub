// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDduotFV1ZIrBkNtwdPgQIfFourHQgEmmg",
  authDomain: "classroom-hub-21f79.firebaseapp.com",
  databaseURL: "https://classroom-hub-21f79-default-rtdb.firebaseio.com",
  projectId: "classroom-hub-21f79",
  storageBucket: "classroom-hub-21f79.firebasestorage.app",
  messagingSenderId: "1024585802487",
  appId: "1:1024585802487:web:a0f103fd1a56d740ada9f2",
  measurementId: "G-R8CR44ENDZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
