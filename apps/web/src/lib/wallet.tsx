"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import { keyAccount, signerFromKey, walletAccount, type Account, type ConnectedWallet } from "./near";

/** A testnet account this server offers for the local demo (see /api/demo-accounts). */
export interface DemoAccount { accountId: string; key: string; label: string }

export interface Wallet {
  /** The connected NEAR account id. */
  address?: string;
  /** Sends transactions for `address`. */
  client?: Account;
  kind?: "wallet" | "demo";
  label?: string;
  demoAccounts: DemoAccount[];
  /** Opens the wallet picker (NEAR Connect: HOT, Meteor, Intear, MyNearWallet, …). Resolves once an account is connected. */
  connectWallet: () => Promise<void>;
  /** Local demo only: acts for one of this machine's keychain accounts. */
  useDemo: (a: DemoAccount) => void;
  disconnect: () => void;
  /** The connect dialog is app-wide so any "connect" prompt can open it. */
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
}

const Ctx = createContext<Wallet | undefined>(undefined);
const DEMO_KEY = "maskbid.near.demo";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<Account>();
  const [kind, setKind] = useState<"wallet" | "demo">();
  const [label, setLabel] = useState<string>();
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const connector = useRef<Promise<NearConnector> | undefined>(undefined);

  // The connector touches window and IndexedDB, so it is made in the browser only, once.
  const getConnector = useCallback(() => (connector.current ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
    const c = new NearConnector({ network: "testnet", features: { testnet: true, signAndSendTransaction: true } });
    c.on("wallet:signIn", (t) => {
      const accountId = t.accounts[0]?.accountId;
      if (!accountId) return;
      try { localStorage.removeItem(DEMO_KEY); } catch {}
      setClient(walletAccount(accountId, t.wallet as unknown as ConnectedWallet)); setKind("wallet"); setLabel(undefined);
    });
    c.on("wallet:signOut", () => { setClient((cur) => (cur && kindRef.current === "wallet" ? undefined : cur)); });
    return c;
  })), []);
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const connectWallet = useCallback(async () => {
    await (await getConnector()).connect();
  }, [getConnector]);

  const useDemo = useCallback((a: DemoAccount) => {
    setClient(keyAccount(signerFromKey(a.accountId, a.key))); setKind("demo"); setLabel(a.label);
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(a)); } catch {}
  }, []);

  const disconnect = useCallback(() => {
    if (kindRef.current === "wallet") getConnector().then((c) => c.disconnect()).catch(() => {});
    setClient(undefined); setKind(undefined); setLabel(undefined);
    try { localStorage.removeItem(DEMO_KEY); } catch {}
  }, [getConnector]);

  useEffect(() => {
    let demo: DemoAccount | null = null;
    try { demo = JSON.parse(localStorage.getItem(DEMO_KEY) ?? "null"); } catch {}
    fetch("/api/demo-accounts").then((r) => r.json()).then((j: { accounts?: DemoAccount[] }) => {
      const list = j.accounts ?? [];
      setDemoAccounts(list);
      const saved = demo && list.find((a) => a.accountId === demo!.accountId); // only while this server still offers it
      if (saved) useDemo(saved);
    }).catch(() => {});
    // Restore a wallet session from an earlier visit.
    getConnector().then((c) => c.getConnectedWallet()).then(({ wallet, accounts }) => {
      if (accounts[0] && !demo) { setClient(walletAccount(accounts[0].accountId, wallet as unknown as ConnectedWallet)); setKind("wallet"); }
    }).catch(() => {});
  }, [getConnector, useDemo]);

  const value = useMemo<Wallet>(() => ({
    address: client?.accountId, client, kind, label, demoAccounts, connectWallet, useDemo, disconnect, connectOpen, setConnectOpen,
  }), [client, kind, label, demoAccounts, connectWallet, useDemo, disconnect, connectOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): Wallet {
  const w = useContext(Ctx);
  if (!w) throw new Error("WalletProvider missing");
  return w;
}
