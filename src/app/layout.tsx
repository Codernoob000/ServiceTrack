import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ServiceTrack — Vehicle Service Management",
  description: "Track car service progress, transparent multi-point inspections, and verified repair records.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-[#ffffff] text-[#111827]">
        {children}
      </body>
    </html>
  );
}
