"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, http, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, CHAIN_ID, IS_LOCAL, RPC_URL } from "./config";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/** Anvil default accounts. Shown only on chain 31337 so three bidders can be driven from one browser. */
export const DEV_ACCOUNTS: { label: string; key: `0x${string}` }[] = [
  { label: "#0 seller / admin / registrar", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { label: "#1 bidder A", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { label: "#2 bidder B", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { label: "#3 bidder C", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { label: "#4 participant", key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { label: "#5 participant", key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
  { label: "#7 verifier", key: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
];

export interface Wallet {
  address?: Address;
  chainId?: number;
  wrongChain: boolean;
  kind?: "injected" | "dev";
  label?: string;
  client?: WalletClient;
  hasInjected: boolean;
  connectInjected: () => Promise<void>;
  connectDev: (key: `0x${string}`) => void;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  /** The connect dialog is app-wide so any "connect" prompt can open it. */
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
}

const Ctx = createContext<Wallet | undefined>(undefined);
const STORAGE = "maskbid.wallet";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [kind, setKind] = useState<"injected" | "dev">();
  const [client, setClient] = useState<WalletClient>();
  const [hasInjected, setHasInjected] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const connectDev = useCallback((key: `0x${string}`) => {
    if (!IS_LOCAL) return;
    const account = privateKeyToAccount(key);
    setClient(createWalletClient({ account, chain, transport: http(RPC_URL) }));
    setAddress(account.address);
    setChainId(CHAIN_ID);
    setKind("dev");
    try { localStorage.setItem(STORAGE, JSON.stringify({ kind: "dev", key })); } catch {}
  }, []);

  const connectInjected = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const wc = createWalletClient({ chain, transport: custom(eth) });
    const [addr] = await wc.requestAddresses();
    const id = await wc.getChainId();
    setClient(createWalletClient({ account: addr, chain, transport: custom(eth) }));
    setAddress(addr);
    setChainId(id);
    setKind("injected");
    try { localStorage.setItem(STORAGE, JSON.stringify({ kind: "injected" })); } catch {}
  }, []);

  const disconnect = useCallback(() => {
    setClient(undefined); setAddress(undefined); setChainId(undefined); setKind(undefined);
    try { localStorage.removeItem(STORAGE); } catch {}
  }, []);

  const switchChain = useCallback(async () => {
    if (!client || kind !== "injected") return;
    try {
      await client.switchChain({ id: CHAIN_ID });
    } catch {
      await client.addChain({ chain });
    }
    setChainId(await client.getChainId());
  }, [client, kind]);

  useEffect(() => {
    setHasInjected(Boolean(window.ethereum));
    let saved: { kind?: string; key?: `0x${string}` } = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}"); } catch {}
    if (saved.kind === "dev" && saved.key) connectDev(saved.key);
    else if (saved.kind === "injected" && window.ethereum) connectInjected().catch(() => {});
  }, [connectDev, connectInjected]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth || kind !== "injected") return;
    // account change ends the previous session's private UI state
    const onAccounts = (accounts: unknown) => {
      const list = accounts as Address[];
      if (!list.length) disconnect();
      else { setAddress(list[0]); setClient(createWalletClient({ account: list[0], chain, transport: custom(eth) })); }
    };
    const onChain = (id: unknown) => setChainId(Number(id));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => { eth.removeListener("accountsChanged", onAccounts); eth.removeListener("chainChanged", onChain); };
  }, [kind, disconnect]);

  const value = useMemo<Wallet>(() => ({
    address, chainId, kind, client, hasInjected, connectInjected, connectDev, disconnect, switchChain, connectOpen, setConnectOpen,
    wrongChain: chainId !== undefined && chainId !== CHAIN_ID,
    label: kind === "dev" ? DEV_ACCOUNTS.find((a) => privateKeyToAccount(a.key).address === address)?.label : undefined,
  }), [address, chainId, kind, client, hasInjected, connectInjected, connectDev, disconnect, switchChain, connectOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): Wallet {
  const w = useContext(Ctx);
  if (!w) throw new Error("WalletProvider missing");
  return w;
}
