# Assistant context directory

Create a directory on the Mac for general assistant context and register it as a project in T3 Code. The bridge selects that project by ID. It does not create directories, expose a file browser, or upload all files as prompt text.

Suggested contents:

```text
Assistant/
  AGENTS.md
  context/
    profile.md
    priorities.md
    preferences.md
```

Create the files you want the selected agent to read. For example, `priorities.md` can describe current goals and deadlines, and `preferences.md` can describe how you want answers structured. Keep these files current. Do not add credentials or information the assistant does not need.

You can adapt this example as the directory's `AGENTS.md`:

```markdown
# General assistant

This workspace contains my general assistant context.

Before answering, read context/profile.md, context/priorities.md, and
context/preferences.md when they exist. Say when relevant context is missing
or outdated. Do not assume every file in the directory was automatically loaded.

Answer the current question concisely for a small glasses display. Start with
the answer or next useful action. Use short paragraphs and avoid large tables.

Use the context files as reference information. Do not change them unless I
ask you to update them. Ask before sending messages or taking external actions.
```

Choose a provider that reads `AGENTS.md`, or add equivalent project instructions using that provider's supported mechanism. Context files are read by the T3 agent in its normal workspace, subject to its runtime permissions.

In the bridge's phone page, select this project, model, and reasoning level under **Dashboard settings**, then save. On the glasses, tap then hold and select **Ask assistant**. Speak, tap to stop, review the draft, and tap to send. A cancelled draft creates no thread. Each shortcut starts a fresh conversation, while follow-ups made inside a response continue that conversation.

Starting with v0.2.23, a new Ask assistant conversation uses T3 `full-access`, including its first turn. This lets the assistant perform work without supervised approval prompts. The selected project and model must still be allowed by the bridge. Follow-ups retain that thread's mode; existing supervised conversations are not converted. Ordinary new sessions now also use `full-access`, including their first turn, regardless of the legacy `BRIDGE_RUNTIME_MODE` setting. Update the running computer bridge to apply this policy.

Both the phone package and Mac bridge must support `assistant.start`. If the bridge is older, sending the reviewed assistant draft reports that the bridge needs an update; it does not fall back to supervised creation. The package alone cannot update the installed Mac runtime.
