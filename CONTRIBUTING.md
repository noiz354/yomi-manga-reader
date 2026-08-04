# Contributing

## 1. Golden Rules

1. **No fake implementations.** A stub throws a typed error rather than
   returning invented data. Tests never hardcode product data — the seed
   harness (`scripts/seed.mjs`) is the only fixture path.
2. **Dependency rules are enforced.** `features/*` never imports `server/*`;
   only `server/db` imports drizzle; only `server/storage` imports the S3 SDK;
   only `server/telemetry` imports OTel SDK packages. ESLint fails CI otherwise.
3. **Secrets stay in the environment.** No credential, session secret or
   connection string is committed or logged.

## 2. Branching & Commits

- Branch names: `<type>/<short-slug>` (e.g. `feat/reader-window`).
- Commit messages: Conventional Commits — `feat(reader): ...`,
  `fix(uploads): ...`, `test(reader): ...`, `docs: ...`, `chore: ...`.
- One concern per branch; a branch may hold several commits but should not mix
  unrelated changes.

## 3. Definition of Done

A change is done when all hold:

1. Behaviour matches what was asked, including edge cases.
2. Tests cover it: unit always; integration when persistence or storage is
   touched; E2E when user-visible.
3. `npm run typecheck`, `npm run lint` and `npm run test:unit` pass.
4. Integration tests pass when the change touches persistence (Docker PG/S3).
5. a11y (axe) passes on touched routes; UI changes were checked in a browser at
   desktop and mobile viewports.

## 4. Verification Commands

```
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # eslint (incl. boundary rules) + prettier check
npm run test:unit        # vitest run tests/unit
npm run test:integration # vitest run tests/integration (needs compose: up)
npm run test:e2e         # playwright test (needs app + compose + seed)
npm run build            # next build
npm run perf:bundle      # bundle budget check
```

Order of verification (fast first): typecheck → lint → focused unit →
integration (if DB/storage touched) → E2E (if user-visible) → build.

## 5. Dependencies

- Install with `npm ci` only (the lockfile is committed; never hand-edit it).
- `npm audit --audit-level=high` blocks CI.
- Version bumps: patch/minor via dependency automation (reviewed); major bumps
  need a written justification and a full verification run.

## 6. Code Style

- TypeScript strict (tsconfig is the source of truth); no `any` — use `unknown`
  plus narrowing.
- Naming: files kebab-case, types/interfaces PascalCase, functions/vars camelCase.
- Comments explain *why* — invariants, constraints, workarounds — not what the
  line already says.
- Error handling: throw typed `AppError` (shared/contracts/errors.ts); route
  handlers map it to the API error shape — never leak internals.

## 7. Review Checklist

- [ ] Boundary rules respected (imports).
- [ ] Security implications considered for new surfaces.
- [ ] Performance considered on hot paths (bundle budget for client code).
- [ ] a11y for UI (axe + keyboard).
- [ ] Tests: unit always; integration if data; E2E if user-visible.
- [ ] Browser-verified for UI changes.
