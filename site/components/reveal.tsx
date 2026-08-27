"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/**
 * Fade a section in as it arrives.
 *
 * Small on purpose — 12 pixels and 400ms. Anything larger reads as a website
 * performing rather than a tool working, and this page is asking a sceptical
 * reader to believe a measurement.
 *
 * `once` matters: re-animating on every scroll past turns the page into
 * something that keeps moving while somebody is trying to read it.
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
