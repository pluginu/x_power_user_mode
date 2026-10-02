# X Power User Plugin v1.9.37

A Chrome extension for reviewing an X profile queue, following eligible profiles, and preparing personalized DMs. After setup, **Start** runs profile collection → location and follower checks → follow when needed → draft → prepare DM → send (if automatic sending is enabled) → next profile. Settings save as you edit; there is no separate Save or per-profile approval click in automatic mode. Keep the side panel and X tab open. Login prompts, closed inboxes, and page errors can still require attention.

The plugin folder is `x_power_user_plugin`, matching the display name **X Power User Plugin**. For ZIP downloads, rename the extracted folder to `x_power_user_plugin` before loading it in Chrome.

## Install in Chrome

1. Download this repository using **Code → Download ZIP** on GitHub and extract it, or run `git clone https://github.com/pluginu/x_power_user_mode.git x_power_user_plugin`.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the `x_power_user_plugin` folder containing `manifest.json` (not its parent folder or the ZIP).
4. Open `https://x.com`, sign in, and refresh the tab. Open **X Power User Plugin** from Chrome’s extensions menu; pin it for easier access.
5. Open the extension’s **Side Panel**, enter your OpenAI API key, project facts, and one X handle per line in **Profiles**. Draft generation requires an API key with API access and available billing/credits.
6. Select **Existing DM workflow**. Leave **USA only** and **Check follower count** enabled. Set minimum/maximum followers and optionally **Must follow me**. The default minimum is 0 with no maximum; the follower count must still be readable.
7. Enable **Automatically send messages** if you want DMs sent after the configured checks without another approval click. It is off by default. Configure the pause between profiles and message options.
8. Click **Start** once. Keep the side panel open. **Pause** or **Stop** suspends subsequent automatic actions; a send already clicked cannot be recalled.

For updates, replace the files in the same folder and click **Reload** in `chrome://extensions`. Existing X tabs reload automatically so the updated content script replaces the invalidated build. Confirm **v1.9.37** appears in the panel. When moving from the original plugin folder, use **Export Backup** there and **Import Backup** here to transfer settings and progress. Backups include the saved API key; keep them private. Browser storage is separate from this Git repository.

## v1.9.37: automatically skip unavailable engagement

Private profiles, sensitive-content profile warnings, and profiles without enough eligible posts are marked skipped with a saved reason, and engagement continues to the next handle without user input. Skipped engagement outcomes remain skipped when resuming. Confirmed actions are retained; unavailable profiles are not marked contacted.

## v1.9.36: skip profiles with no eligible posts

Automatic engagement now records a skipped outcome and continues to the next profile when no eligible original posts are available to like or comment on. The completed pass summary reports these profiles separately instead of pausing the entire queue.

## v1.9.35: paste replies through one editor event

Public replies now enter X's contenteditable composer through one paste event. The extension no longer combines a direct DOM replacement with an input notification, which X could reconcile as two copies. The paste data stays inside the page event and does not read or replace the system clipboard.

## v1.9.34: prevent duplicated reply text

Public replies now populate X's contenteditable composer with one deterministic replacement and one input notification instead of `execCommand`, which X could process twice. Submission still requires an exact stable text match. Generation requests now require one-line plain ASCII text, and returned messages are cleaned of emoji, markdown, escape sequences, line breaks, and unsupported characters before use.

## v1.9.33: recognize alternate X Reply controls

Reply submission recognizes X's current test IDs, native submit buttons, and visible Reply/Post labels. It waits longer for the control and reports separate editor and button diagnostics if X still does not make the composer ready.

## v1.9.32: slow the actual reply submission click

Reply submission now pauses for 1.5 seconds after X's Reply control is fully ready, then revalidates the composer and clicks once. This delay is separate from the existing editor-render and text-stability waits.

## v1.9.31: replace stale content scripts automatically

Reloading or updating the extension now reloads existing X tabs so Chrome injects the current content script instead of leaving the invalidated previous build attached to the page.

## v1.9.30: stop invalidated content-script work

Extension reloads now stop the replaced content script's timers and consume the expected `Extension context invalidated` rejection from Chrome APIs that were already in flight. Side-panel timer and storage-change callbacks also contain rejected promises.

## v1.9.29: contain startup storage failures

Background DM resume timers now stop when the content script is disconnected after an extension reload. Resume failures are caught even if storage also fails while reporting the error, and diagnostic log failures no longer reject into the workflow. A failed initial storage read does not create a preparation record. Reload the extension and refresh existing X tabs to replace old scripts.

Validated with 161 mocked browser tests; live Chrome/X behavior still needs verification.

## v1.9.28: accept reply composers without a post permalink

The reply guard now binds the composer to the verified post's Reply click instead of requiring a clickable post permalink inside the dialog. It finds the dialog containing the editor, including nested dialog layouts. When post links are present, post IDs are compared independently of tracking queries, handle casing, or media suffixes. Closed or replaced composers and conflicting post links still stop submission with a specific error.

For an unsent draft left by the old guard, close and discard it, reload the extension, refresh X, reopen the side panel, and resume. Confirmed progress is preserved.

## v1.9.27: reply composer recovery

Reply insertion now avoids sending a second text insertion while X is rendering the first. Submission waits for stable exact text and an enabled button. The navigation guard accepts X's compose URL only for the same open reply dialog containing the target post link. Unconfirmed submissions still pause without automatic retries.

If an older version left a duplicated draft open, close and discard that unsent reply, reload the extension, refresh X, reopen the side panel, and resume. Confirmed engagement is preserved. This release also includes the generated-text cleanup below.

## v1.9.26: no em dashes in generated output

Every LLM response is normalized before reaching the UI, logs, or saved data. Em dashes and horizontal bars become commas in messages, public replies, and all structured metadata strings. Both drafting prompts and the shared generation instruction request this style. Existing saved drafts are not rewritten by this update.

## v1.9.25: like and comment before following

In **Outreach workflow → Mode**, choose **Like + comment → follow · no DMs**. Set **Likes before follow** and **Comments before follow** (0 skips that action), then click **Start**. Comments require an OpenAI API key. Both this mode and **Like + comment → follow · staged DMs** finish the configured post engagement before following. If posts or confirmations are missing, the queue pauses before following; confirmed progress survives resuming. Already-followed accounts remain followed. Existing follow-only settings stay follow-only until you select the new mode.

Reload the extension, refresh X, and reopen the side panel to see the new controls. The DM wait applies only to staged DMs, which still require approval.

## v1.9.24: explain skipped engagement and find pinned posts

Post discovery now accepts original pinned posts and timestamp links outside the author block while excluding reposts and quoted authors. If required engagement cannot be completed from the loaded posts, the queue pauses on that profile with a specific reason instead of advancing silently. Confirmed actions remain saved.

Each profile shows its latest outcome and filter rejection reason. The end-of-pass summary distinguishes completed, filtered, already-complete, and unavailable/contacted profiles. Follow-only mode labels its buttons **Start automatic follows** and explicitly explains that likes and comments are disabled. Select **Automatic engagement · staged DMs** for likes and comments. The existing location and follower filters still apply; USA-only rejects missing and ambiguous locations. Set **Any location** only if that matches your intended audience.

Regression checks cover alternate timestamp placement, pinned posts, quoted authors, empty post scans, and persistent filter reasons. Live signed-in X compatibility remains unverified.

## v1.9.23: automatic engagement

Choose **Automatic follow · no DMs** to follow eligible profiles, or **Automatic engagement · staged DMs** to also like loaded original posts and publish brief AI-generated replies. Click **Start** once and keep the side panel and X tab open. The queue checks your location/follower filters, performs actions on X, and advances with the configured delay. Comments require an OpenAI API key. Pause stops subsequent actions.

Only visibly confirmed actions count toward staged eligibility; old manual records remain in backups but do not count. Following requires X's Following state, likes require its Unlike state, and comments require a new posted-link receipt. An unconfirmed comment pauses the queue and leaves a persistent submission marker to prevent duplicate replies. Inspect X before resolving that marker. If too few original posts are loaded, confirmed progress is retained and the queue continues; Start retries incomplete profiles. No scrolling or continuous timeline engagement is performed. DMs retain their staged waiting period and approval requirement.

Earlier release notes below describe historical behavior.

## v1.9.22: explain manual review waits

The header and Start button now describe the selected workflow. Review modes open one profile and wait for your manual interactions; they do not automatically follow, like, or comment. Starting review from the toolbar opens the side panel so the instructions remain visible. Diagnostic exports now include the selected mode, review handle, automatic-send setting, and workflow deadline to help distinguish an intentional wait from a failed step.

If the existing DM workflow stops unexpectedly, use **Export debug log** and check the displayed status. This update clarifies review waits; it does not add automatic likes or comments or establish the cause of an unobserved live failure.

## v1.9.20: profile loading and follow detection

The queue now checks profile readiness even while Chrome reports the tab is loading, so background page resources cannot hold up an otherwise ready profile. Follow detection excludes recommendation cards and posts, and reads button text and accessibility labels separately. Unknown follow states are checked again before drafting or DM preparation; late controls get a bounded wait. A Follow click is reported as successful only after X shows Following.

Reload the extension and refresh the X tab to activate these changes. Keep the side panel open while the queue runs. If it still pauses, use **Export debug log** to capture the workflow stage and page diagnostics.

## USA-only profile and follower review

**USA only is enabled by default**, including for existing installations without this setting. It checks the profile’s stated location before following, drafting, preparing, or sending. Supported forms include `USA`, `United States`, `California`, `Austin, TX`, and `Atlanta, Georgia, USA`. Bare abbreviations such as `CA`, ambiguous `Georgia`, city-only locations, blank locations, and unsupported/multiple locations are skipped. This is a conservative text filter, not verified residency or nationality; a profile’s own location may be inaccurate. Turn it off only if you want other locations allowed.

**Follower review** checks the displayed follower count against your limits and optionally requires the visible **Follows you** relationship. Counts like `1,234` and `1.2K` are accepted; abbreviated counts use the displayed rounded value. Missing/unreadable counts fail review. This does not inspect individual followers or infer their country, authenticity, or quality. Profile review here means these configured eligibility checks, not a human review or an AI quality score.

A failed check saves the profile as **skipped**, with an eligibility reason, and moves to the next profile without following or drafting. These records survive reloads and appear in exports/backups. Changing filters does not automatically requeue skipped profiles. **Reset progress** makes them eligible for collection again but also clears all contact and engagement history; use it only when intentionally restarting the entire queue.

Automatic DMs require **Existing DM workflow** and **Automatically send messages**. **Follow review · no DMs** still blocks all DMs, and **Staged outreach · manual approval** still requires manual interaction records and per-message approval. Location and follower checks apply in these modes too. The content script rechecks current settings before a send, so an already prepared draft cannot bypass a newly enabled filter. Send and Follow controls receive one activation per attempt; uncertain sends are flagged for review rather than automatically retried.

## Local validation

Run `node --test tests/workflow.test.cjs` with Node.js. Tests exercise eligibility rejection, queue progression, follow/send action guards, persistence, and automatic sending using mocked Chrome/X behavior. Live X UI compatibility still needs verification after installation; no live follows or DMs were performed during development.

## Earlier releases

The history below describes earlier builds. The v1.9.19 eligibility rules above apply to their workflows.

## v1.9.18: manual engagement and staged DM review

In **Outreach workflow**, select **Follow review · no DMs** or **Staged outreach · manual approval**. Changing modes pauses the existing queue and turns automatic sending off. Review modes do not automate likes, comments, or follows.

1. Add handles to Profiles. Click **Start** or **Open next for review** to visit the next profile without a recorded follow.
2. Engage manually on X. Enter the review handle and the post URL, then click **Record like** or **Record comment**. Click **Record follow** after following. Records are your confirmations, not automatically verified X activity. Duplicate interactions on the same post do not increase counts. **Undo last record** corrects mistakes.
3. Click **Open next for review** to continue. You can revisit any profile using its review button.
4. In staged mode, set required distinct liked posts, commented posts, and the waiting period in days. A recorded follow is required. The waiting period begins at the first recorded interaction; deleting that record recalculates it. The queue shows eligibility and the local eligibility time, refreshed every minute.
5. Once eligible, open the profile, **Collect + save profile**, **Generate tailored draft**, **Prepare DM**, then **Send & Next** to approve that one DM. No automatic DM is triggered when time expires. Follow-review mode blocks drafting, preparing, and sending DMs entirely.

Enable **Timeline matches** to mark posts from listed authors as you browse X's Home timeline, including For You and Following. This scans loaded posts every three seconds while the tab is open; it does not scroll, search, click, or monitor a closed browser. Use the matched post directly, then record your interaction in the panel.

Engagement records survive restarts and complete backups. Reset progress also removes them. Reload the extension and refresh X tabs after updating. Local tests mock the browser; live X UI verification remains necessary.

## Message length and optional reference

Choose **Short** (30–45 words), **Usual** (60–90 words, the default), or **Extra long** (150–220 words) in Message options. These are generation targets, not hard truncation limits.

Paste reference text or upload a UTF-8 `.txt` or `.md` file (up to 20,000 characters), then set **Reference text** to **Use reference text**. To use only part, highlight a passage in the reference box and click **Keep selected passage**. You can edit the text, switch it off without deleting it, or clear it. Reference text guides tone and wording; profile and project facts remain the source for factual claims.

Options save automatically, sync between the popup and side panel, and apply to subsequent manual and automatic drafts. Existing drafts stay as generated until you regenerate them. Enabled reference text is sent with the generation request; saved reference text is included in complete backups.

# v1.9.17 — Automatically skip nonexistent accounts throughout preparation

- “This account doesn’t exist” (also with a straight apostrophe) saves `account_not_found` and advances the running queue without a prompt, including when a profile header remains visible or the notice appears during DM preparation.
- Missing and suspended records stay excluded after reopening. Stale drafts cannot send to either status.
- Reload the extension in place and refresh X to activate **v1.9.17**.

# v1.9.16 — Recover profile navigation after redirects and resume

- Start reopens a profile left in the loading step with a fresh timeout instead of resuming an expired wait.
- If X finishes on Home or another wrong route, the queue retries profile navigation up to three times, allowing five seconds between attempts. It waits for in-flight navigation instead of repeatedly reloading it.
- Debug logs now include the requested profile URL, tab, attempt, browser response, and route mismatches.
- Reload the extension in place, refresh X, then click Start to activate **v1.9.16** and retry the saved record.

# v1.9.15 — Skip suspended accounts

- An explicit **Account suspended** notice on the target profile saves `account_suspended` and advances the running queue without waiting for a profile timeout, drafting, or sending. Notices appearing during DM preparation are handled too.
- Suspended records remain excluded after reopening the extension and are included in saved progress and exports.
- Reload the extension in place and refresh X to activate **v1.9.15**.

# v1.9.14 — Startup and stale-window persistence fixes

- Saving now waits for stored settings and progress to finish loading. An idle popup only writes settings actually edited there, so it cannot overwrite a newer queue from the side panel.
- Next-recipient selection reads the queue from storage and checks durable processed records. Separate popup/panel regression tests verify that stale windows cannot restart an old queue.
- Reload the existing extension in place, refresh X, and verify **v1.9.14** in the panel. The **Saved progress** counter shows the restored records for the queue.

# v1.9.13 — Durable progress across reloads

- Completed recipient records are saved under independent storage keys. Overlapping writes to the older shared profile map cannot erase contact/skip history. The X content script saves successful sends directly before returning to the panel, so closing or reloading the panel does not lose the result.
- Opening the extension loads these records, migrates older contact flags and case variants, and recovers saved `sent` jobs even if the current-profile pointer is missing. Queue selection and stale saved positions both skip processed recipients. Start restores valid collection/draft checkpoints instead of replacing them with stale UI values.
- **Saved progress** shows processed and remaining recipients for the current queue. Complete backups include the durable records; profile exports merge them into the exported records. Only **Reset progress** intentionally clears this history.
- Update the existing unpacked extension in place: reload it in `chrome://extensions`, refresh X, and reopen the side panel. Verify **v1.9.13**. Progress is stored in Chrome's extension-local storage, not in the source folder. Removing the extension or loading it as a different extension requires exporting/importing a Complete Backup to preserve that data.
- Reload regression tests cover panel closure during a send, stale queue positions, overlapping map writes, legacy records, checkpoint restoration, completed queues, and explicit reset. Live X messages were not sent during testing.

# v1.9.12 — Automatic sending and queue recovery

- Enable **Automatically send messages**, then click **Start**. The saved toggle is off by default and is shared by the popup and side panel. Enabling it during a running queue also sends the current ready draft. With it off, each recipient still needs **Send & Next**.
- Keep the side panel open and X available while running. Pause/Stop prevents further automatic sends; a click already dispatched to X cannot be recalled. Finishing that send no longer restarts a paused/stopped queue.
- Automatic mode retries loading/drafting/preparation failures twice, with 10- and 20-second backoffs. After that, it saves `needs_review` and the error, then advances. Send failures or interrupted sends with an unknown result go directly to `needs_review` and are never automatically retried. These records are excluded from subsequent queues; inspect their conversation and saved errors before manually preparing them again. CSV/JSON exports include the errors and retry counts.
- Saved successful sends are reconciled on reopening the panel, even if the response channel was lost. Incomplete sends have a deadline, unknown workflow states enter recovery, and stale preparation failures cannot overwrite a newer job. OpenAI fetches now abort after 110 seconds, within the panel's 120-second deadline.
- Reload the extension in `chrome://extensions`, refresh X, and reopen the side panel. Verify **v1.9.12** before starting. Local tests use mocked browser/X behavior; no live messages were sent during validation.

The sections below describe earlier versions; v1.9.12 behavior above supersedes their manual-only sending and pause-on-error descriptions.

# v1.9.11 — Automatic preparation and diagnostics

- Accounts showing X’s “This account doesn’t exist” notice are saved as `account_not_found` and automatically skipped on this and future queue runs.

- **Start** automatically collects, drafts, and prepares each queued profile. **Prepare DM** also starts these steps for the open profile if collection/drafting have not finished. Once both checkpoints exist, Prepare DM reuses the current draft, including your edits. Only **Send & Next** sends a message, after your approval.
- Profile loading allows up to 120 seconds and requires profile data to stay stable for 1.5 seconds. Message-button and composer discovery each allow up to 90 seconds. Draft generation allows 120 seconds. The preparation watchdog allows 6 minutes across navigation and editor retries; successful steps proceed immediately.
- Preparation acknowledges its request immediately and reports progress through saved state, so page navigation does not require a long-lived response channel. Repeated Prepare DM clicks do not replace an active preparation job.
- The panel shows its version and extension ID. **Test page connection** detects older content scripts and asks you to refresh X. **Export debug log** downloads UI/page diagnostics, workflow stage, timing, tab information, and errors without exporting the API-key setting. Page diagnostics use separate storage so UI logging cannot overwrite them.
- Reload the extension in `chrome://extensions`, refresh X, reopen the side panel, and verify **v1.9.11** is shown. Keep X visible and the side panel open while the workflow runs.

# X Power User Plugin — DM readiness and automatic queue fix

- **Start** opens the side panel and runs **Collect + save profile → Generate tailored draft → Prepare DM**, waiting for each action to finish. Starting an unfinished profile clears stale drafts and runs the full sequence again. Keep the side panel open while the queue runs; reopening it resumes the saved workflow.
- When X shows **@recipient has a closed inbox** with **Not Now / Use X Number**, the extension clicks **Not Now**, saves `dm_unavailable` with reason `closed_inbox`, and automatically processes the next record. The saved profile and draft remain available, with `alternativeOutreachNeeded: true` and the notice evidence included in CSV/JSON exports. This does not mark the person contacted.
- **Mark Contacted** saves the current contact and automatically starts processing the next uncontacted profile without sending a message.
- **Send & Next** remains the manual approval for each recipient. If clicked while preparation is finishing, it waits instead of rejecting the `profile_message_clicked` stage. Send detection supports labeled controls, modern DM test IDs, and the composer form’s submit button. After approval, the extension waits for X to clear the draft, then automatically prepares the next profile using your configured pause.
- DM preparation waits up to 90 seconds for a stable, editable message box, explicitly focuses it, and checks focus before insertion. It retries if X replaces the editor or drops the text, and only marks a draft prepared after the full text persists. On approval, Send-button detection polls the live editor for up to 60 seconds and rechecks the recipient, conversation, and reviewed text before clicking, so an icon-only Send control cannot leave a filled draft stuck in preparation.
- Search fields are excluded from composer detection. Buttons receive one click per action. Preparation stays bound to its original X tab.
- Pause/Stop suspend queue progression. A real loading, drafting, or preparation error pauses with a status message; fix it and click Start to retry. Preparation already in flight may finish, but never sends automatically.
- If X does not clear the draft after Send, check the conversation before retrying. The extension does not repeat an uncertain send automatically.

**Update:** Reload this unpacked extension in `chrome://extensions`, refresh the X tab, then click **Start**. No settings reset is needed.

**Local checks:** `node --test tests/workflow.test.cjs` covers asynchronous composer readiness, focus, editor replacement, send guards, and the approval boundary. These are mocked browser checks; live X verification is still required.

---

# X Power User Plugin v17

This build fixes direct-DM composer detection on X. Prepare DM now prefers the currently focused editable element (the cursor-ready message box), then falls back across visible contenteditable/textbox/textarea editors, including open shadow roots. It no longer requires X to expose a specific `dmComposerTextInput` selector.

# X Power User Plugin v15

This build fixes X Chat's three-panel **New chat** detection using X's exact current selector:

`button[data-testid="dm-empty-conversation-new-chat-button"]`

It also waits for the button through DOM mutations, then continues the saved Prepare DM job: New chat -> recipient search -> exact handle match -> conversation -> insert persisted draft.

All v13 persistence, complete backup/import, profile history, settings, API key persistence, follow handling, and debug logging remain included.

After loading/reloading the extension in `chrome://extensions`, refresh existing X tabs once so the new content script is injected.
# X Power User Plugin v13

This build consolidates the previous fixes into one stateful workflow.

## Key fixes

- If X positively shows **Follow**, Generate Draft / Prepare DM now clicks Follow first instead of permanently blocking that profile.
- Old `not_following` records are migrated to `follow_required` so they are not permanently skipped.
- API key and all editable settings save automatically as you type. You do not need to click Save to keep them.
- **Complete Backup really is complete**: it exports every value in `chrome.storage.local`, including the OpenAI API key when present. Treat the backup JSON like a password because it can contain that secret.
- Complete Backup import clears the extension's current local storage and restores the backup exactly, avoiding stale mixed-version data.
- Profile state uses one storage key (`profiles`) everywhere. Earlier builds mixed `profiles` and `profileDb`.
- Debug log uses one string format everywhere instead of sometimes being a string and sometimes an array.
- Prepare DM continues after popup closure and uses the X Chat UI: Chat landing page -> New chat -> recipient picker -> exact @handle -> conversation -> saved draft insertion.
- Recipient search is scoped to the recipient dialog so the left-side Chat search box is not mistaken for the New Chat recipient field.
- Send & Next verifies the pending prepared recipient before clicking Send.

## Install / update

1. Locate the `SIN-Outreach-Assistant` folder containing `manifest.json` (unzip first if needed).
2. Open `chrome://extensions`.
3. If replacing an existing SIN build, use **Export Backup** in that build first to preserve settings and progress, then disable it.
4. Enable Developer mode and choose **Load unpacked**.
5. Select `SIN-Outreach-Assistant`, the folder containing `manifest.json`.
6. If replacing an existing build, use **Import Backup** in the newly loaded extension to restore your saved data.
7. Refresh any already-open X tabs once, then use **Test page connection** to verify the connection.

### After renaming or moving the folder

The plugin uses relative asset paths and does not require a particular root folder name. Chrome must still load the correct folder: use **Load unpacked** to select its new location if the existing registration points elsewhere. Follow the backup and restore steps above when replacing an existing registration. Keep only the intended X Power User Plugin build enabled.

Run local checks with `node --test tests/workflow.test.cjs` from the plugin folder, or pass the absolute path to that test file from another directory.

## Backup security

The Complete Backup intentionally contains **all extension-local data**, including the OpenAI API key if one is stored. Keep the backup private. The profile CSV/JSON exports remain separate and are intended for profile records rather than extension secrets/settings.


## v15 direct profile DM fix
Prepare DM no longer opens generic X Chat or searches for the recipient. It returns to the saved X profile when needed, finds that profile's Message button, clicks it, waits for the direct conversation composer, and inserts the persisted draft. The pending job survives popup closure and full-page navigation.


## v17 side panel + timer fix
- Added Chrome Side Panel support. Use **Open in Side Panel** from the toolbar popup. The side panel stays open while you interact with X, so the toolbar popup no longer steals focus from the page.
- Removed the hard-coded 10-second minimum delay from both the HTML controls and JavaScript. Values below 10 seconds now work; 0 seconds is allowed.
- The side panel uses the exact same persistent state, profile database, generated draft, API key, backup/import, logs, and workflow as the popup.
