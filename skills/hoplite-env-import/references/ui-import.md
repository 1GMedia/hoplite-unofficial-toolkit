# Hoplite UI import details

Use the current computer-use tools and their returned documentation. The macOS
app and web app both expose project Environment settings. Choose the surface
that can complete the task; authorization errors in one surface do not justify
bypassing authentication or guessing API writes.

## Read the supplied JSON safely

For native accessibility reads, hold the observation in the persistent runtime
without emitting it:

```javascript
let sourceState = await browserApp.getAXState({
  emit: false,
  disableDiffing: true,
});
```

Do not print this state or take a screenshot while credentials are visible.
Inspect only control types, safe field names, and counts. Tool exceptions may
echo bad arguments; do not pass secret strings to diagnostic output or use
source-bearing exception messages.

A 1Password secure note can split JSON across native accessibility nodes: a URL
inside a JSON string may become a **link** between two **text** nodes. Reassemble
only the note's content in its displayed order. Use the link's displayed URL
once, not both its caption and its `Value` attribute; the latter may omit the
scheme. Exclude unrelated page headings, footer links, and controls. Confirm
the reconstructed text parses as the complete object before changing Hoplite.

Do not hardcode the item title, source link, node IDs, project name, variable
count, or credentials from a previous run. Keep credential strings out of tool
call source; reference runtime variables instead.

## Stage the import

Read the destination project identity and current controls from a fresh
observation. In the observed Mac UI, bulk import is supported by pasting a `.env`
into **Key**, not into **Value**. Use this only when the current view advertises
bulk parsing. With strict validation complete and all values inside the safe
single-quote subset, construct the payload in memory:

```javascript
let entries = Object.entries(environmentObject);
if (entries.some(([, value]) => /['\r\n]/.test(value))) {
  throw new Error('Use individual Key/Value fields for this import');
}
let payload = entries.map(([key, value]) => `${key}='${value}'`).join('\n');
await hopliteApp.click(keyFieldIndex);
await hopliteApp.paste(payload);
let staged = await hopliteApp.getAXState({ emit: false, disableDiffing: true });
```

After every UI action, fetch fresh state before deciding the next action and
derive indices from that state. A paste can report that the application did not
read the clipboard even though all rows were staged. Check for imported names,
pending changes, and an enabled Save control before repeating it.

## Compare values and save

Read values through **Edit <key>** using fresh control indices. Hold the returned
state privately and compare the exact editable string with the source. Native
accessibility can put a textarea's `Placeholder` before or after `Value`.
Extract the field value using the current representation, excluding a known
placeholder suffix only when it is actually metadata. If the boundary is
ambiguous, switch to a supported DOM field-value read rather than truncating or
normalizing a credential. URLs and JSON string values must remain byte-for-byte
the source strings; outer `.env` quotes should be removed by the parser.

Close each unchanged editor with **Cancel**. Opening or cancelling an editor can
move the visible list, so refresh and scroll to collect the remaining rows.
Track compared keys in a set instead of relying on row counts in one snapshot.
Emit only the number compared and any missing key names.

Save the staged changes once, then check the asynchronous result. Once the
unsaved state clears, navigate away and reopen Environment for the same project.
Collect saved row names across the full scroll range and compare the set with
the import. Preserve pre-existing keys that were outside its scope. When checking
exact saved values is supported, compare them privately as well.

A successful import receipt describes:

- the verified workspace and repository-qualified project;
- the expected and persisted variable counts;
- exact staged-value comparison and, if available, exact saved-value comparison;
- any unresolved mismatch or incomplete save.

Do not include value lengths, tokens, private shared links, source notes, screenshots,
or full secret-bearing observations in the receipt. Clear source, reconstructed
JSON, `.env`, and editable-value buffers when complete. The device-wide installed
skill contains only this procedure and synthetic fixtures.
