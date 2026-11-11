// base.js — shared UI state and constants used by the other UI files (loaded first)
"use strict";



const chat = new ChatView($("#messages"));
const input = $("#input");
let attachments = [];  // {kind:"image"|"file", name, mediaType, data, size}

const MODES = [
  { id: "default", label: "Ask before acting", short: "Ask", desc: "Claude asks before editing files or running commands." },
  { id: "acceptEdits", label: "Auto-accept edits", short: "Auto-edit", desc: "File edits go through; commands still ask." },
  { id: "plan", label: "Plan mode", short: "Plan", desc: "Claude researches and proposes a plan without changing anything." },
  { id: "auto", label: "Auto mode", short: "Auto", desc: "A safety classifier approves routine actions and asks about risky ones." },
  { id: "bypassPermissions", label: "Bypass permissions", short: "Bypass", desc: "Everything runs without asking. Only for trusted, sandboxed work.", warn: true },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SUGGESTIONS = ["Explain what this project does and how it's organized", "Find and fix a bug in this folder", "Write tests for the main module", "Set up a new Android app project here"];
