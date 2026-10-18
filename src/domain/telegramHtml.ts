// The coach writes Markdown; Telegram shows a small HTML subset and no tables. Tables
// become aligned monospace blocks, **bold** stays bold, headings become bold lines.

const TELEGRAM_CHUNK = 3800;

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(text: string) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function plainCell(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function isSeparatorRow(line: string) {
  return line.includes("-") && !line.replace(/[|:\-\s]/g, "");
}

function tableBlock(lines: string[]) {
  const rows = lines
    .filter((line) => !isSeparatorRow(line))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(plainCell));
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const text = rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
        .join("  "),
    )
    .join("\n");
  return `<pre>${escapeHtml(text)}</pre>`;
}

// Markdown → blocks of Telegram HTML; a block (paragraph, list, table) is never split.
export function markdownToTelegramBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join("\n"));
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      continue;
    }
    if (line.trim().startsWith("|")) {
      flush();
      const table: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        table.push(lines[index]);
        index += 1;
      }
      index -= 1;
      blocks.push(tableBlock(table));
      continue;
    }
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(`<b>${escapeHtml(plainCell(heading[1]))}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    paragraph.push(bullet ? `${bullet[1]}• ${inline(bullet[2])}` : inline(line));
  }
  flush();
  return blocks;
}

// Telegram allows 4096 characters per message; whole blocks are packed into chunks, and
// only a block longer than a whole message is cut (by lines).
export function markdownToTelegramChunks(markdown: string, limit = TELEGRAM_CHUNK) {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && current.length + piece.length + 2 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  };
  for (const block of markdownToTelegramBlocks(markdown)) {
    if (block.length <= limit) {
      push(block);
      continue;
    }
    const pre = block.startsWith("<pre>");
    const body = pre ? block.slice(5, -6) : block;
    let piece = "";
    for (const line of body.split("\n")) {
      if (piece && piece.length + line.length + 12 > limit) {
        push(pre ? `<pre>${piece}</pre>` : piece);
        piece = "";
      }
      piece = piece ? `${piece}\n${line.slice(0, limit - 12)}` : line.slice(0, limit - 12);
    }
    if (piece) push(pre ? `<pre>${piece}</pre>` : piece);
  }
  if (current) chunks.push(current);
  return chunks;
}

// Telegram rejected the HTML (should not happen): the same text without any tags.
export function telegramHtmlToPlain(html: string) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
