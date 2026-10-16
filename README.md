# pi-swe-replay

A minimal [Pi coding agent](https://github.com/earendil-works/pi) extension package.

It contributes one command:

```text
/greet [name]
```

For example, `/greet Ada` displays `Hello, Ada!`.

## Use locally

From this repository, start Pi with the extension explicitly:

```bash
pi --extension ./extensions/index.ts
```

Or install this directory as a project-local Pi package:

```bash
pi install --local .
```

After granting project trust, Pi discovers the extension through the `pi` manifest in `package.json`.
