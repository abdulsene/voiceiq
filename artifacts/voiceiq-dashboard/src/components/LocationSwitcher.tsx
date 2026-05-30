import { useState, useRef, useEffect } from "react";
import { MapPin, ChevronDown, Building2, Check } from "lucide-react";
import { useLocation } from "./LocationContext";

export default function LocationSwitcher() {
  const { locations, selectedLocationId, setSelectedLocationId, hasMultipleLocations } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (locations.length === 0) return null;

  const currentLabel = selectedLocationId === "all"
    ? "All Locations"
    : locations.find((l) => l.id === selectedLocationId)?.location_name || "Select Location";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors text-sm font-medium text-gray-700 shadow-sm"
      >
        <MapPin className="w-4 h-4 text-[#2E75B6]" />
        <span className="max-w-[180px] truncate">{currentLabel}</span>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-50 py-1 overflow-hidden">
          {hasMultipleLocations && (
            <button
              onClick={() => { setSelectedLocationId("all"); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors ${selectedLocationId === "all" ? "text-[#2E75B6] bg-blue-50" : "text-gray-700"}`}
            >
              <Building2 className="w-4 h-4" />
              <span className="flex-1 text-left">All Locations</span>
              {selectedLocationId === "all" && <Check className="w-4 h-4" />}
            </button>
          )}
          {hasMultipleLocations && <div className="border-t border-gray-100 my-1" />}
          {locations.map((loc) => (
            <button
              key={loc.id}
              onClick={() => { setSelectedLocationId(loc.id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors ${selectedLocationId === loc.id ? "text-[#2E75B6] bg-blue-50" : "text-gray-700"}`}
            >
              <MapPin className="w-4 h-4" />
              <div className="flex-1 text-left">
                <div className="font-medium">{loc.location_name}</div>
                {loc.address && <div className="text-xs text-gray-400 truncate">{loc.address}</div>}
              </div>
              {loc.is_primary && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">Primary</span>}
              {selectedLocationId === loc.id && <Check className="w-4 h-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
