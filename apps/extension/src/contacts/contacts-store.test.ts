import { afterEach, describe, expect, it } from "vitest";
import {
  __setContactsBackend,
  addContact,
  findContact,
  listContacts,
  removeContact,
  type Contact,
  type ContactsBackend,
} from "./contacts-store.js";

function memBackend(): ContactsBackend {
  let list: Contact[] = [];
  return {
    async get() {
      return list;
    },
    async set(l) {
      list = l;
    },
  };
}

afterEach(() => __setContactsBackend(null));

describe("contacts-store", () => {
  it("adds, finds (case-insensitive), and lists sorted by name", async () => {
    __setContactsBackend(memBackend());
    await addContact("Bob", "PRL1ABC");
    await addContact("Alice", "prl1xyz");
    expect((await listContacts()).map((c) => c.name)).toEqual(["Alice", "Bob"]);
    expect((await findContact("prl1abc"))?.name).toBe("Bob");
  });

  it("upserts by address (rename keeps a single entry)", async () => {
    __setContactsBackend(memBackend());
    await addContact("Bob", "prl1abc");
    await addContact("Bobby", "prl1abc");
    const all = await listContacts();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("Bobby");
  });

  it("removes by address (case-insensitive)", async () => {
    __setContactsBackend(memBackend());
    await addContact("Bob", "prl1abc");
    await removeContact("PRL1ABC");
    expect(await listContacts()).toHaveLength(0);
  });

  it("ignores empty name or address", async () => {
    __setContactsBackend(memBackend());
    await addContact("", "prl1abc");
    await addContact("Bob", "   ");
    expect(await listContacts()).toHaveLength(0);
  });
});
