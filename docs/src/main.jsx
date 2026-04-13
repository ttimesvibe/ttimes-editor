import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null, info: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { this.setState({ info }); console.error("React Error Boundary:", error, info); }
  render() {
    if (this.state.hasError) {
      return React.createElement("div", { style: { padding: 40, fontFamily: "monospace", background: "#1a1a2e", color: "#eee", minHeight: "100vh" } },
        React.createElement("h2", { style: { color: "#EF4444" } }, "React Render Error"),
        React.createElement("pre", { style: { background: "#111", padding: 16, borderRadius: 8, overflow: "auto", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "#F59E0B" } },
          String(this.state.error)),
        React.createElement("pre", { style: { background: "#111", padding: 16, borderRadius: 8, overflow: "auto", fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap", color: "#94A3B8", marginTop: 12, maxHeight: 400 } },
          this.state.info?.componentStack || ""),
        React.createElement("button", {
          onClick: () => { this.setState({ hasError: false, error: null, info: null }); },
          style: { marginTop: 16, padding: "8px 20px", background: "#3B82F6", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14 }
        }, "Retry")
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>
);
