import React from "react";
import { useParams } from "react-router-dom";
import { useCharms } from "@/contexts/CharmsContext";

export default function CharmDetail() {
  const { id } = useParams<{ id: string }>();
  const { charms } = useCharms();
  const charm = charms.find((c) => c.entityId === id);

  if (!charm) {
    return <div>Charm not found</div>;
  }

  return (
    <div className="p-4">
      <h2>Charm Detail: {charm.name}</h2>
      <div>{charm.ui}</div>
    </div>
  );
}
