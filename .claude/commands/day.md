---
description: Execute a specific Day's module (1-10) from ROADMAP.md, run verification tests, and commit/push to GitHub
---

You are executing **Day $ARGUMENTS** of the AegisVault 10-Day Modular Build Plan.

Follow this exact 6-step execution protocol without skipping any step:

1. **PRE-FLIGHT CHECK:**
   - Read `CLAUDE.md` and `ROADMAP.md`.
   - Locate the section for **Day $ARGUMENTS**.
   - If Day $ARGUMENTS is greater than 1, verify in `ROADMAP.md` and `git log -n 5` that the previous day's module is completed. If not, stop and warn the user.

2. **SCOPED IMPLEMENTATION:**
   - Implement ONLY the files, modules, and tests specified under **Day $ARGUMENTS** in `ROADMAP.md`.
   - Do not scaffold or stub code belonging to later days unless explicitly required for TypeScript compilation.

3. **MANDATORY VERIFICATION GATE:**
   - Run the exact **Verification Command** listed for Day $ARGUMENTS in `ROADMAP.md` (plus `pnpm turbo run typecheck && pnpm turbo run test`).
   - Read the full terminal output and check the exit code.
   - If any test or typecheck fails, fix the root cause and re-run until 0 errors remain.

4. **UPDATE PROGRESS TRACKER:**
   - In `ROADMAP.md`, change Day $ARGUMENTS's status from `[ ] Pending` to `[x] Completed` and append today's completion summary.

5. **GIT COMMIT & PUSH TO GITHUB:**
   - Run `git status` and `git diff --stat` to ensure no secrets (`.env`), build artifacts (`dist/`, `node_modules/`), or unrelated files are staged.
   - Stage all Day $ARGUMENTS files and `ROADMAP.md` (`git add .`).
   - Commit using the exact **Conventional Commit Message** specified for Day $ARGUMENTS in `ROADMAP.md`.
   - Push to the remote repository (`git push -u origin HEAD`).

6. **DAILY STANDUP REPORT:**
   - Output a concise summary of: (a) files created/modified, (b) test suite results, (c) the Git commit SHA pushed to GitHub, and (d) what is queued next for the following day.
