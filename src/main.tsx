import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { CharacterWindow } from "./character/CharacterWindow";
import { TrayPanel } from "./tray/TrayPanel";
import "./styles.css";

// Route by window label: the control panel vs. a character window.
function Root() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("get_window_label")
      .then(setLabel)
      .catch(() => setLabel("char__unknown__0"));
  }, []);

  if (label === null) return null;
  if (label === "tray-panel") return <TrayPanel />;
  return <CharacterWindow />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
