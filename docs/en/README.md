[Deutsch](../README.md) · **English**

# Documentation

| Document | For whom | Contents |
|---|---|---|
| [User guide](user-guide.md) | Everyone who works with Lotse | How the interface works: chat, context, preview, approval and undo, layouts, style guide, rules, knowledge, shop check, settings, Sandbox Coding, language |
| [Self-hosting](self-hosting.md) | Anyone running Lotse on a server | Login via environment variable, host names, HTTPS and reverse proxy, enabling Sandbox Coding (Docker), backups, troubleshooting |
| [Architecture](architecture.md) | Development and security review | Flow of a chat turn, protection layers, data storage, preview, layout publishing, shop check, chats with a sandbox, prompts, internationalization, tests |
| [Platform layer](platform.md) | Anyone adding or adapting a platform | Adapter contract, capability matrix Shopware/Shopify/Magento 2/OpenMage, checklist for new adapters |

## Sandbox Coding

Code tasks in a development environment with git and a test shop of its own (Docker), in which Claude Code or Codex work. Where to find what:

- **Using it:** [A sandbox in the chat](user-guide.md#sandbox-coding-a-sandbox-in-the-chat) (tabs, data, console, working with the AI, submitting for review), [Start sandbox: every case](user-guide.md#start-sandbox-every-case) (plugin, new plugin, whole project, own setup, without a project, `.lotse/sandbox.json`, notes for the AI), [Saved environments: set up once, a fresh sandbox for every job](user-guide.md#saved-environments-set-up-once-a-fresh-sandbox-for-every-job), [Whole Shopware project](user-guide.md#whole-shopware-project), [Without a developer: build your own plugin](user-guide.md#without-a-developer-build-your-own-plugin)
- **Running it:** [Enable Sandbox Coding](self-hosting.md#enable-sandbox-coding) (Docker, networks, variables, setup steps, dumps)
- **Understanding and reviewing it:** [Chats with a sandbox](architecture.md#chats-with-a-sandbox-sandbox-coding) (tools, console, publishing, every case), [`SECURITY.en.md`](../../SECURITY.en.md) (security model)

Other files in the repository:

- [`README.en.md`](../../README.en.md) ([Deutsch](../../README.md)): quick start (Docker), security, configuration, releases
- [`SECURITY.en.md`](../../SECURITY.en.md) ([Deutsch](../../SECURITY.md)): security model and how to report issues
- [`CONTRIBUTING.en.md`](../../CONTRIBUTING.en.md) ([Deutsch](../../CONTRIBUTING.md)): contributing, tests, conventions
- [`.env.example`](../../.env.example): all environment variables with explanations
- [`integrations/openmage/README.en.md`](../../integrations/openmage/README.en.md): OpenMage module `Lotse_Connector`
