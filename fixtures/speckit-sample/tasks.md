# Tasks: Sample Feature

## Phase 1: Setup
- [ ] T001 Create project structure in src/
  - acceptance: src/ and tests/ directories exist with entry points
  - files: src/**, tests/**
  - shape: chore

## Phase 2: Core
- [ ] T002 [P] Implement token refresh in src/auth/refresh.ts
  - acceptance: expired token triggers exactly one refresh attempt
  - acceptance: refresh failure surfaces a typed error
  - files: src/auth/**
  - complexity: 7
- [ ] T003 [P] Implement session store in src/auth/store.ts
  - acceptance: sessions persist across restarts
  - files: src/auth/**
- [ ] T004 Write integration tests for auth flow
  - acceptance: happy path and refresh-failure path covered
  - files: tests/**
