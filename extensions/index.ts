/**
 * pi-stash — a personal stash of reusable prompt fragments for the Pi coding
 * agent. Jot a prompt down whenever you think of it, then later pull up the
 * list and pop one into the editor to compose your next message.
 *
 * Unlike file-based prompt templates (static `/name` commands), this is an
 * ad-hoc, mutable, stack-like backlog you build up by hand during real work.
 *
 * Commands:
 *   /stash <text>  Push: save the given text onto the stash.
 *   /stash         Pop: pick a saved entry → insert it into the editor and
 *                  remove it from the stash. Run repeatedly to stack fragments.
 *   /stash-clear   Delete every entry (with confirm).
 *
 * Storage: a single global JSON file, shared across every Pi session on the
 * machine (not per-project, not per-session). Default location:
 *   ~/.pi/agent/prompt-stash.json
 * Override with the PI_STASH_PATH environment variable.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StashEntry {
	text: string;
	addedAt: number;
}

const STORE_PATH = process.env.PI_STASH_PATH || join(homedir(), ".pi", "agent", "prompt-stash.json");
const PREVIEW_LEN = 72;

function load(): StashEntry[] {
	try {
		const raw = readFileSync(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((e): e is StashEntry => e && typeof e.text === "string");
		}
	} catch {
		// missing or corrupt → empty stash
	}
	return [];
}

function save(entries: StashEntry[]): void {
	mkdirSync(dirname(STORE_PATH), { recursive: true });
	writeFileSync(STORE_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/** One-line, length-bounded preview for select menus. */
function preview(text: string, index: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const body = oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN - 1)}…` : oneLine;
	// Number prefix keeps labels unique so indexOf() round-trips reliably.
	return `${String(index + 1).padStart(2, " ")}. ${body}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stash", {
		description: "Push text (with arg) or pop an entry into the editor (no arg)",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();

			// PUSH: /stash <text>
			if (text) {
				const entries = load();
				if (entries.some((e) => e.text === text)) {
					ctx.ui.notify("Already in stash", "info");
					return;
				}
				entries.push({ text, addedAt: Date.now() });
				save(entries);
				ctx.ui.notify(`Stashed (${entries.length} total)`, "info");
				return;
			}

			// POP: /stash → pick, insert into editor, remove from stash
			const entries = load();
			if (entries.length === 0) {
				ctx.ui.notify("Stash is empty. Add one with /stash <text>", "info");
				return;
			}
			const labels = entries.map((e, i) => preview(e.text, i));
			const choice = await ctx.ui.select("Pop prompt:", labels);
			if (choice === undefined) return; // cancelled / timed out
			const idx = labels.indexOf(choice);
			if (idx < 0) return;

			const chosen = entries[idx].text;
			const current = ctx.ui.getEditorText() ?? "";
			const next = current.trim().length > 0 ? `${current}\n${chosen}` : chosen;
			ctx.ui.setEditorText(next);

			// pop = remove the chosen entry
			entries.splice(idx, 1);
			save(entries);
		},
	});

	pi.registerCommand("stash-clear", {
		description: "Delete every stashed prompt",
		handler: async (_args, ctx) => {
			const entries = load();
			if (entries.length === 0) {
				ctx.ui.notify("Stash is already empty", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Clear the entire stash?", `${entries.length} entries will be deleted`);
			if (!ok) return;
			save([]);
			ctx.ui.notify("Stash cleared", "info");
		},
	});
}
