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
 * Shortcut:
 *   Alt+S          If the editor holds text, push it onto the stash (and clear
 *                  the editor); otherwise pop a saved entry into the editor.
 *                  A one-key way to park the prompt you're typing, or pull one
 *                  back, without typing `/stash`.
 *
 * Storage: each change is written to a per-session backup and recorded via
 * `pi.appendEntry` for branch history. Resuming the same saved session restores
 * its stash; branches and forks use their own active path.
 *
 * While the stash is non-empty, a red badge with the entry count is shown in
 * the footer so you don't forget about pending prompts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface StashEntry {
	text: string;
	addedAt: number;
}

const CUSTOM_TYPE = "pi-stash-state";
const STATUS_KEY = "pi-stash";
const PREVIEW_LEN = 72;

interface Checkpoint {
	version: 1;
	sessionId: string;
	sessionFile: string;
	parentId: string | null;
	entryId: string | null;
	entries: StashEntry[];
}

function checkpointPath(ctx: ExtensionContext): string {
	return join(ctx.sessionManager.getSessionDir(), "pi-stash", `${ctx.sessionManager.getSessionId()}.json`);
}

function readCheckpoint(ctx: ExtensionContext): Checkpoint | undefined {
	let raw: string;
	try {
		raw = readFileSync(checkpointPath(ctx), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		ctx.ui.notify(`Could not read stash backup: ${String(error)}`, "error");
		return undefined;
	}
	try {
		const value = JSON.parse(raw) as Checkpoint;
		if (
			value.version !== 1 || value.sessionId !== ctx.sessionManager.getSessionId() ||
			typeof value.sessionFile !== "string" ||
			!(value.parentId === null || typeof value.parentId === "string") ||
			!(value.entryId === null || typeof value.entryId === "string") ||
			!Array.isArray(value.entries) ||
			!value.entries.every((e) => e && typeof e.text === "string" && typeof e.addedAt === "number")
		) throw new Error("Invalid stash backup");
		return value;
	} catch (error) {
		ctx.ui.notify(`Could not parse stash backup: ${String(error)}`, "error");
		return undefined;
	}
}

function writeCheckpoint(ctx: ExtensionContext, checkpoint: Checkpoint): void {
	const path = checkpointPath(ctx);
	mkdirSync(join(ctx.sessionManager.getSessionDir(), "pi-stash"), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(checkpoint), { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* Nothing to clean up if creation failed. */ }
		throw error;
	}
}

/** One-line, length-bounded preview for select menus. */
function preview(text: string, index: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const body = oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN - 1)}…` : oneLine;
	// Number prefix keeps labels unique so indexOf() round-trips reliably.
	return `${String(index + 1).padStart(2, " ")}. ${body}`;
}

export default function (pi: ExtensionAPI) {
	// In-memory stash for the current session; persisted as custom entries and a disk checkpoint.
	let entries: StashEntry[] = [];

	function persist(next: StashEntry[], ctx: ExtensionContext): boolean {
		const parentId = ctx.sessionManager.getLeafId();
		const checkpoint: Checkpoint = {
			version: 1,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			parentId,
			entryId: null,
			entries: next,
		};
		if (ctx.sessionManager.getSessionFile()) {
			try {
				// Write first: a new Pi session may not have flushed its custom entries yet.
				writeCheckpoint(ctx, checkpoint);
			} catch (error) {
				ctx.ui.notify(`Could not save stash backup: ${String(error)}`, "error");
				return false;
			}
		}
		let appended = false;
		try {
			pi.appendEntry(CUSTOM_TYPE, { entries: next });
			appended = true;
		} catch (error) {
			if (!ctx.sessionManager.getSessionFile()) {
				ctx.ui.notify(`Could not save stash: ${String(error)}`, "error");
				return false;
			}
			ctx.ui.notify(`Stash backed up, but session entry failed: ${String(error)}`, "error");
		}
		entries = next;
		updateStatus(ctx);
		if (appended && ctx.sessionManager.getSessionFile()) {
			try {
				writeCheckpoint(ctx, { ...checkpoint, entryId: ctx.sessionManager.getLeafId() });
			} catch (error) {
				// The first write already saved the state, even if this link update fails.
				ctx.ui.notify(`Stash backed up, but checkpoint update failed: ${String(error)}`, "error");
			}
		}
		return true;
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

	// Restore the latest snapshot on this branch; a checkpoint cannot leak into another branch.
	function restore(ctx: ExtensionContext): void {
		entries = [];
		const branch = ctx.sessionManager.getBranch();
		let snapshotIndex = -1;
		for (const [index, entry] of branch.entries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as { entries?: unknown } | undefined;
				if (data && Array.isArray(data.entries)) {
					entries = data.entries.filter(
						(e): e is StashEntry => !!e && typeof (e as StashEntry).text === "string",
					);
					snapshotIndex = index;
				}
			}
		}
		const checkpoint = ctx.sessionManager.getSessionFile() ? readCheckpoint(ctx) : undefined;
		if (checkpoint) {
			const checkpointIndex = branch.findIndex((entry) => entry.id === checkpoint.entryId);
			const freshSameId = checkpoint.sessionFile !== ctx.sessionManager.getSessionFile() &&
				branch.every((entry) =>
					entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info"
				);
			if (checkpointIndex >= snapshotIndex && checkpointIndex >= 0) {
				entries = checkpoint.entries;
			} else if (
				checkpointIndex < 0 &&
				(checkpoint.entryId === null || !ctx.sessionManager.getEntry(checkpoint.entryId)) &&
				((branch.at(-1)?.id ?? null) === checkpoint.parentId || freshSameId)
			) {
				// Recover a missing entry or an unflushed session reopened with the same explicit ID.
				entries = checkpoint.entries;
			}
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	/**
	 * Core stash behaviour shared by the `/stash` command and the Alt+S
	 * shortcut. With text → push; without text → pop into the editor.
	 */
	async function runStash(rawText: string, ctx: ExtensionContext): Promise<boolean> {
		const text = (rawText ?? "").trim();

		// PUSH: /stash <text>
		if (text) {
			if (entries.some((e) => e.text === text)) {
				ctx.ui.notify("Already in stash", "info");
				return false;
			}
			if (!persist([...entries, { text, addedAt: Date.now() }], ctx)) return false;
			ctx.ui.notify(`Stashed (${entries.length} total)`, "info");
			return true;
		}

		// POP: /stash → pick, insert into editor, remove from stash
		if (entries.length === 0) {
			ctx.ui.notify("Stash is empty. Add one with /stash <text>", "info");
			return false;
		}
		const labels = entries.map((e, i) => preview(e.text, i));
		const choice = await ctx.ui.select("Pop prompt:", labels);
		if (choice === undefined) return false; // cancelled / timed out
		const idx = labels.indexOf(choice);
		if (idx < 0) return false;

		const chosen = entries[idx].text;
		const current = ctx.ui.getEditorText() ?? "";
		const next = current.trim().length > 0 ? `${current}\n${chosen}` : chosen;
		// Do not remove the entry unless the new state was saved.
		if (!persist(entries.filter((_, i) => i !== idx), ctx)) return false;
		ctx.ui.setEditorText(next);
		return true;
	}

	pi.registerCommand("stash", {
		description: "Push text (with arg) or pop an entry into the editor (no arg)",
		handler: async (args, ctx) => {
			await runStash(args ?? "", ctx);
		},
	});

	// Alt+S → same as bare `/stash`: pop an entry into the editor. If the
	// editor already holds text, push it onto the stash instead.
	pi.registerShortcut("alt+s", {
		description: "Stash: push editor text, or pop a saved prompt",
		handler: async (ctx) => {
			const editorText = (ctx.ui.getEditorText() ?? "").trim();
			if (editorText) {
				if (await runStash(editorText, ctx)) ctx.ui.setEditorText("");
			} else {
				await runStash("", ctx);
			}
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
			if (persist([], ctx)) ctx.ui.notify("Stash cleared", "info");
		},
	});
}
