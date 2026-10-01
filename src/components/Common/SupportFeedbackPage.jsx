import React from "react";
import { useSearchParams } from "react-router-dom";
import SupportFeedbackContent from "./SupportFeedbackContent";

export default function SupportFeedbackPage() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") || "feedback";

  return (
    <div style={{ minHeight: "85vh", width: "100%" }}>
      <SupportFeedbackContent defaultTab={initialTab} isModal={false} />
    </div>
  );
}
