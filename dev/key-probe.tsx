/**
 * Logs every key this terminal delivers, and what it did to the editor buffer.
 *
 * Type a few letters, then press the key you are testing (ctrl+J, shift+enter, option+enter),
 * then a few more. Quit with ctrl+C and read the log — it records the parsed key alongside the
 * buffer contents, so "the terminal never sent it" and "the editor ignored it" are told apart.
 *
 *   bun run probe:key            # writes /tmp/imgen-keys.log
 *   cat /tmp/imgen-keys.log
 *
 * The log is a file rather than the screen on purpose: reading state back through a render is
 * what made two earlier attempts at this measurement come back empty.
 */
import { createCliRenderer, type TextareaRenderable } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { appendFileSync, writeFileSync } from "node:fs";
import * as React from "react";

const LOG = process.env.IMGEN_KEY_LOG ?? "/tmp/imgen-keys.log";

function Probe() {
  const editor = React.useRef<TextareaRenderable | null>(null);
  const [count, setCount] = React.useState(0);

  React.useEffect(() => {
    writeFileSync(LOG, `probe started · TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "(unset)"}\n`);
  }, []);

  useKeyboard((key) => {
    // Read the buffer after the editor has had the same key, so the line records cause and effect.
    setTimeout(() => {
      const text = editor.current?.editBuffer.getText() ?? null;
      appendFileSync(
        LOG,
        [
          `name=${key.name}`,
          `shift=${key.shift}`,
          `ctrl=${key.ctrl}`,
          `option=${key.option}`,
          `seq=${JSON.stringify(key.sequence)}`,
          `buffer=${JSON.stringify(text)}`,
        ].join("  ") + "\n",
      );
    }, 40);
    setCount((n) => n + 1);
  });

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <text fg="#8B5CF6">imgen — key probe</text>
      <text fg="#9CA3AF">
        Type letters, press the key you are testing, type more. ctrl+C to quit.
      </text>
      <text fg="#9CA3AF">{`logging ${count} keys to ${LOG}`}</text>
      <textarea ref={editor} focused={true} width="100%" height={8} wrapMode="none" />
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<Probe />);
