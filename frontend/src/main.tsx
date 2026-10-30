import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { keepPasswordManagersAway } from "./passwordManagers";
import { applyTheme, currentTheme } from "./themes";

applyTheme(currentTheme().id); // the theme last used in this browser, before anything draws
const root = document.getElementById("root")!;
keepPasswordManagersAway(document.body); // only the sign-in forms should offer to save passwords (body: popups live outside #root)
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
