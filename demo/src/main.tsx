import "./polyfills";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No StrictMode: the Lab holds an imperative SDK/harness instance, and we want a
// single, stable instantiation rather than dev-mode double-mounting.
createRoot(document.getElementById("root")!).render(<App />);
