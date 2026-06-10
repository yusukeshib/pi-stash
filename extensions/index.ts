/**
 * pi-stash — a per-session stash of reusable prompt fragments for the Pi
 * coding agent. Jot a prompt down whenever you think of it, then later pull
 * up the list and pop one into the editor to compose your next message.
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
 * Storage: stash entries are persisted INSIDE the session itself via custom
 * session entries (`pi.appendEntry`). Each session has its own stash, it
 * survives restarts/resume, and it follows branching (fork/clone) correctly.
 *
 * While the stash is non-empty, a red badge with the entry count is shown in
 * the footer so you don't forget about pending prompts.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface StashEntry {
	text: string;
	addedAt: number;
}

const CUSTOM_TYPE = "pi-stash-state";
const STATUS_KEY = "pi-stash";
const PREVIEW_LEN = 72;

/** One-line, length-bounded preview for select menus. */
function preview(text: string, index: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const body = oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN - 1)}…` : oneLine;
	// Number prefix keeps labels unique so indexOf() round-trips reliably.
	return `${String(index + 1).padStart(2, " ")}. ${body}`;
}

export default function (pi: ExtensionAPI) {
	// In-memory stash for the current session; persisted as custom entries.
	let entries: StashEntry[] = [];

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, { entries });
	}

	/** Red, hard-to-miss footer badge while the stash is non-empty. */
	function updateStatus(ctx: ExtensionContext): void {
		if (entries.length > 0) {
			// White on red background (raw ANSI so it stays red in any theme).
			ctx.ui.setStatus(STATUS_KEY, `\x1b[41m\x1b[97m\x1b[1m stash:${entries.length} \x1b[0m`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	// Restore stash from the session (last persisted state on the active path).
	pi.on("session_start", async (_event, ctx) => {
		entries = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as { entries?: unknown } | undefined;
				if (data && Array.isArray(data.entries)) {
					entries = data.entries.filter(
						(e): e is StashEntry => !!e && typeof (e as StashEntry).text === "string",
					);
				}
			}
		}
		updateStatus(ctx);
	});

	pi.registerCommand("stash", {
		description: "Push text (with arg) or pop an entry into the editor (no arg)",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();

			// PUSH: /stash <text>
			if (text) {
				if (entries.some((e) => e.text === text)) {
					ctx.ui.notify("Already in stash", "info");
					return;
				}
				entries.push({ text, addedAt: Date.now() });
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`Stashed (${entries.length} total)`, "info");
				return;
			}

			// POP: /stash → pick, insert into editor, remove from stash
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
			persist();
			updateStatus(ctx);
		},
	});

	pi.registerCommand("stash-clear", {
		description: "Delete every stashed prompt in this session",
		handler: async (_args, ctx) => {
			if (entries.length === 0) {
				ctx.ui.notify("Stash is already empty", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Clear the entire stash?", `${entries.length} entries will be deleted`);
			if (!ok) return;
			entries = [];
			persist();
			updateStatus(ctx);
			ctx.ui.notify("Stash cleared", "info");
		},
	});
}
