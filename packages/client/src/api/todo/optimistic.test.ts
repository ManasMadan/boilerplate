import { describe, expect, it } from "vitest";
import type { TodoListData } from "./list";
import { applyCreate, applyDelete, applySetCompleted } from "./optimistic";

const todo = (id: string, completed = false) => ({
  id,
  title: id,
  completed,
  version: 1,
  createdAt: new Date(0),
});
const data: TodoListData = {
  pages: [
    { items: [todo("a"), todo("b")], nextCursor: "b" },
    { items: [todo("c")], nextCursor: null },
  ],
  pageParams: [undefined, "b"],
};

describe("optimistic todo updates", () => {
  it("completes the right item on any page and bumps its version", () => {
    const next = applySetCompleted(data, "c", true);
    expect(next?.pages[1]?.items[0]).toMatchObject({ id: "c", completed: true, version: 2 });
    expect(next?.pages[0]?.items.every((item) => !item.completed)).toBe(true);
  });

  it("removes an item and prepends a new one to the first page", () => {
    expect(applyDelete(data, "a")?.pages[0]?.items.map((item) => item.id)).toEqual(["b"]);
    expect(applyCreate(data, todo("new"))?.pages[0]?.items.map((item) => item.id)).toEqual([
      "new",
      "a",
      "b",
    ]);
  });

  it("leaves an empty cache empty", () => {
    expect(applySetCompleted(undefined, "a", true)).toBeUndefined();
  });
});
