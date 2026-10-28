import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { keepPasswordManagersAway } from "./passwordManagers";

const root = document.getElementById("root")!;
keepPasswordManagersAway(document.body); // only the sign-in forms should offer to save passwords (body: popups live outside #root)
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
