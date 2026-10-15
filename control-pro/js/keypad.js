export function makeKeypad(rows) {
  if (!Array.isArray(rows) || rows.length > 10)
    throw new Error("حداکثر ۱۰ ردیف مجاز است.");
  const ids = new Set();
  return {
    rows: rows.map((row) => {
      if (!Array.isArray(row) || !row.length || row.length > 4)
        throw new Error("هر ردیف باید ۱ تا ۴ دکمه داشته باشد.");
      return {
        buttons: row.map((b) => {
          if (!b.id || ids.has(b.id) || !b.text?.trim())
            throw new Error("عنوان و شناسهٔ یکتای دکمه لازم است.");
          ids.add(b.id);
          return {
            id: b.id,
            type: "Simple",
            button_text: b.text.trim().slice(0, 60),
          };
        }),
      };
    }),
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}
export function parseKeypadText(text) {
  if (!text.trim()) return null;
  // Each line is a row, vertical bar separates buttons. Explicit id:text preserves analytics IDs.
  return makeKeypad(
    text
      .trim()
      .split("\n")
      .map((line, i) =>
        line.split("|").map((part, j) => {
          const split = part.indexOf(":");
          return split > 0
            ? {
                id: part.slice(0, split).trim(),
                text: part.slice(split + 1).trim(),
              }
            : { id: `button_${i + 1}_${j + 1}`, text: part.trim() };
        }),
      ),
  );
}
