import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Editor - 3D Terrain Editor",
  description: "Create and edit 3D terrain tiles for games",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-zinc-950 text-white">
        {children}
      </body>
    </html>
  );
}
