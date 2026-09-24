import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SCF Presence Realtime",
  description: "A native realtime voice AI with a living visual body.",
};
export const viewport: Viewport = { themeColor: "#090e16", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
