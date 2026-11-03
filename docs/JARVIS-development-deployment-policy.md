# Development and Deployment Policy

This policy is mandatory for all J.A.R.V.I.S. development work.

## Core principle

Preview deployments and Production deployments are both valuable project environments. Preview is not disposable. Preserve Preview capacity for meaningful verification and treat every deployment as a controlled engineering action.

## Before changing code or pushing

1. Inspect the current branch, commit, working tree, and existing Preview deployments.
2. Group related changes into one coherent change set. Do not create a series of tiny commits or pushes for the same task.
3. Review the complete diff before committing.
4. Run the relevant tests and available syntax, lint, and type checks before pushing.
5. Decide whether a Vercel deployment is genuinely required. Documentation-only edits should not consume a Preview build.
6. Reuse an existing suitable Preview when possible. Do not retry repeatedly after a Vercel build-rate limit.

## Commit and Preview discipline

- Prefer one commit and one Preview per coherent feature or fix.
- Batch related file changes using a single Git tree and commit operation where possible.
- Do not push intermediate or speculative states merely to inspect them in Preview.
- Keep changes that affect application runtime, build configuration, dependencies, or deployment behavior eligible for Preview builds.
- Documentation-only Markdown changes may be skipped by Vercel's Ignored Build Step. The ignore check must fail open: if commit SHAs are missing or the diff cannot be evaluated, continue the build.
- Do not broadly disable Preview deployments. Required Preview verification must remain available.
- Do not exclude application source, configuration, dependency manifests/lockfiles, tests, or database migrations from build decisions without a separately verified CI/test strategy.

## Production safeguards

- Never modify the production branch or deploy/promote to Production without the user's explicit approval.
- Verify the exact branch, commit, environment, and deployment target before any release action.
- Only release changes that have passed the appropriate Preview verification.

## Rate limits and cost

- Treat Vercel Hobby build/deployment limits as a constrained resource.
- Avoid unnecessary deployment creation, repeated builds, and force builds.
- When a rate limit occurs, stop and investigate the cause; do not spam retries.
- Prefer local or CI checks for changes that do not need a deployed environment.

## Required reporting

When a deployment is created, report its environment, commit, status, and URL. Distinguish clearly between checks actually executed and checks not run. Never claim that a Preview was skipped, a build passed, or a setting was applied unless verified.

## Enforcement

This document is the repository-level source of truth for deployment discipline. Any future change to Vercel ignore rules must be reviewed to ensure application changes cannot be accidentally skipped.
