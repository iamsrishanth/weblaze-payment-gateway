import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Weblaze Payment Gateway",
  description: "A self-hostable direct UPI checkout and merchant terminal.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
