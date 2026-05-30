/**
 * Contacts (address book).
 *
 * Non-secret user data: a list of {name, address} the user saves to label
 * recipients. Stored in chrome.storage.local (device-local, trusted contexts)
 * and read/written directly from the popup — no background worker and no key
 * material involved. A tiny injectable backend keeps it unit-testable.
 */

export interface Contact {
  name: string;
  address: string;
  createdAt: number;
}

export interface ContactsBackend {
  get(): Promise<Contact[]>;
  set(list: Contact[]): Promise<void>;
}

const CONTACTS_KEY = "necklace.contacts.v1";

function chromeBackend(): ContactsBackend {
  return {
    async get() {
      try {
        const o = await chrome.storage.local.get(CONTACTS_KEY);
        const v = o[CONTACTS_KEY];
        return Array.isArray(v) ? (v as Contact[]) : [];
      } catch {
        return [];
      }
    },
    async set(list) {
      try {
        await chrome.storage.local.set({ [CONTACTS_KEY]: list });
      } catch {
        // best-effort; contacts are non-critical
      }
    },
  };
}

let backend: ContactsBackend | null = null;

/** Override the backend (tests only). Pass null to reset to chrome.storage.local. */
export function __setContactsBackend(b: ContactsBackend | null): void {
  backend = b;
}

function getBackend(): ContactsBackend {
  if (!backend) backend = chromeBackend();
  return backend;
}

function norm(address: string): string {
  return address.trim().toLowerCase();
}

/** All contacts, sorted by name. */
export async function listContacts(): Promise<Contact[]> {
  const list = await getBackend().get();
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/** The contact for an address, if saved. */
export async function findContact(address: string): Promise<Contact | undefined> {
  const n = norm(address);
  return (await getBackend().get()).find((c) => norm(c.address) === n);
}

/** Add (or rename, by address) a contact. No-op on empty name/address. */
export async function addContact(name: string, address: string): Promise<void> {
  const trimmedName = name.trim();
  const addr = address.trim();
  if (trimmedName.length === 0 || addr.length === 0) return;
  const list = await getBackend().get();
  const n = norm(addr);
  const next = list.filter((c) => norm(c.address) !== n);
  next.push({ name: trimmedName, address: addr, createdAt: Date.now() });
  await getBackend().set(next);
}

/** Remove a contact by address. */
export async function removeContact(address: string): Promise<void> {
  const n = norm(address);
  const list = await getBackend().get();
  await getBackend().set(list.filter((c) => norm(c.address) !== n));
}
