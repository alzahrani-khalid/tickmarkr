<!-- tickmarkr:spec -->
# Eval fixture sample

## T1: Solution text is present
- goal: The fixture reference content is produced
- shape: implement
- acceptance:
  - command: [ "$(cat a.txt)" = "hello from solution" ]
