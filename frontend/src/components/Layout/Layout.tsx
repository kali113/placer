import React from "react";

interface LayoutProps {
  header: React.ReactNode;
  main: React.ReactNode;
  sidebar: React.ReactNode;
}

export function Layout({ header, main, sidebar }: LayoutProps) {
  return (
    <div className="layout-root">
      <div className="scanlines" />
      <div className="vignette" />
      <header className="layout-header">{header}</header>
      <main className="layout-main">
        <section className="layout-canvas-area">{main}</section>
        <aside className="layout-sidebar-area">{sidebar}</aside>
      </main>
    </div>
  );
}
