# Sample PRD: tiny greeter

## T1: Implement greet(name) in src/greet.js
- shape: implement
- complexity: 3
- files: src/**
- acceptance:
  - greet("drover") returns a string containing "drover"
  - module exports a single function

## T2: Cover greet with tests
- deps: T1
- files: test/**
- acceptance:
  - tests fail when greet drops the name
  - npm test exits 0

## T3: Document usage in README
- deps: T1
- humanGate: true
- acceptance:
  - README shows an executable example
