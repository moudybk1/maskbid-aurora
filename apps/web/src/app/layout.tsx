import type { Metadata } from "next";
import { Sora, Spectral } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import { NETWORK } from "@/lib/config";
import { BrandMark } from "@/components/Dots";
import { SkyDefs } from "@/components/Sky";
import { Stipple } from "@/components/Stipple";

// Geometric sans for headings and controls, serif for reading.
const display = Sora({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Spectral({ subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "MaskBid — Private bids. Clear outcomes.",
  description: "Sealed-bid auctions for verified assets with deposits and settlement on NEAR.",
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
          {children}
          <footer className="footer">
            <Stipple kind="cloud" seed={83} className="cloud f1" />
            <Stipple kind="cloud" seed={89} className="cloud f2" />
            <Stipple kind="cloud" seed={97} className="cloud f3" />
            <div className="footer-panel">
              <div className="footer-top">
                <div className="footer-intro">
                  <a className="brand" href="/"><BrandMark />MaskBid</a>
                  <p>Sealed-bid auctions for verified assets. Private bids, clear outcomes, settled on NEAR.</p>
                  <a className="btn btn-sm" href="/auctions">Launch app</a>
                </div>
                <nav className="footer-cols" aria-label="Footer">
                  <div><h3>Auctions</h3><ul><li><a href="/auctions">Browse lots</a></li><li><a href="/sell">Sell an asset</a></li><li><a href="/activity">My activity</a></li></ul></div>
                  <div><h3>Participate</h3><ul><li><a href="/verify">Verify identity</a></li><li><a href="/verifier">Verifier queue</a></li></ul></div>
                  <div><h3>Protocol</h3><ul><li><a href="/config">Deployment config</a></li><li><a href="https://github.com/UyLeQuoc/MaskBid" target="_blank" rel="noreferrer">Upstream design</a></li></ul></div>
                </nav>
              </div>
              <div className="footer-base">
                <span>© {new Date().getFullYear()} MaskBid</span>
                <span className="footer-net"><i aria-hidden="true" />Demo on {NETWORK}</span>
              </div>
            </div>
            <p className="footer-word" aria-hidden="true">MaskBid</p>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
