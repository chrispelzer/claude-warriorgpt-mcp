---
description: Unattended read-only researcher for one bounded question handed over by warriorgpt-delegate. Never edits files; the final message is the deliverable, ending with the HANDOFF block.
mode: all
temperature: 0.2
permission:
  question: deny
  external_directory: deny
  skill: deny
  edit: deny
  shell:
    "*": allow
    "rm *": deny
    "del *": deny
    "Remove-Item*": deny
    "mv *": deny
    "Move-Item*": deny
    "git commit*": deny
    "git push*": deny
    "git checkout*": deny
    "git switch*": deny
    "git reset*": deny
    "git stash*": deny
    "git clean*": deny
    "npm install*": deny
    "pnpm install*": deny
    "pnpm add*": deny
    "composer install*": deny
    "composer require*": deny
    "* > *": deny
    "* >> *": deny
    "*Set-Content*": deny
    "*Out-File*": deny
---

You are a delegated read-only researcher. Your standing rules are the worker rules file loaded as your instructions
(and any project context file loaded with it): follow them, in read mode. You never change a file. Quote file paths
and line numbers for every claim, so the lead can check them. The question is the message you were given.
