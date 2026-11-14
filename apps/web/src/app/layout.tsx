import type { Metadata } from "next";
import { Sora, Spectral } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import { ModeGate } from "@/components/ModeGate";
import { Nav } from "@/components/Nav";
import { WalletControl } from "@/components/WalletControl";
import { BrandMark } from "@/components/Dots";
import { SkyDefs } from "@/components/Sky";
import { Stipple } from "@/components/Stipple";

// Geometric sans for headings and controls, serif for reading.
const display = Sora({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Spectral({ subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "MaskBid — Private bids. Clear outcomes.",
  description: "Sealed-bid auctions for verified assets with deposits and settlement on Aurora.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head>
        {/* The opening sequence plays once per browser session (always with ?intro, never with reduced motion); this runs before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var f=/[?&]intro\\b/.test(location.search),r=matchMedia("(prefers-reduced-motion: reduce)").matches;if(r||(!f&&sessionStorage.mbIntro))document.documentElement.setAttribute("data-seen","");else sessionStorage.mbIntro=1}catch(e){}` }} />
      </head>
      <body>
        <SkyDefs />
        <WalletProvider>
          <header className="header">
            <div className="container header-in">
              <a className="brand" href="/"><BrandMark />MaskBid</a>
              <Nav />
              <div className="header-right"><ModeGate /><WalletControl /></div>
            </div>
          </header>
          <main className="container">{children}</main>
          <footer className="footer">
            <Stipple kind="cloud" seed={83} className="cloud f1" />
            <Stipple kind="cloud" seed={89} className="cloud f2" />
            <Stipple kind="cloud" seed={97} className="cloud f3" />
            <div className="footer-panel">
              <div className="footer-intro">
                <a className="brand" href="/"><BrandMark />MaskBid</a>
                <p>Sealed-bid auctions for verified assets. Private bids, clear outcomes, settled on Aurora.</p>
              </div>
              <div className="footer-cols"><h3>Auctions</h3><ul><li><a href="/#lots">Browse lots</a></li><li><a href="/sell">Sell an asset</a></li><li><a href="/activity">My activity</a></li></ul></div>
              <div className="footer-cols"><h3>Participate</h3><ul><li><a href="/verify">Verify identity</a></li><li><a href="/verifier">Verifier queue</a></li></ul></div>
              <div className="footer-cols"><h3>Protocol</h3><ul><li><a href="/config">Deployment config</a></li><li><a href="https://github.com/UyLeQuoc/MaskBid" target="_blank" rel="noreferrer">Upstream design</a></li></ul></div>
            </div>
            <p className="footer-note">MaskBid · {new Date().getFullYear()} <BrandMark /></p>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
