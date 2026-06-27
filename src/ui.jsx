const fullNav = [
  { key: "library", label: "Library", icon: Library, show: FEATURES.library },
  { key: "syllabus", label: "Syllabus", icon: ScrollText, show: FEATURES.syllabus },
  // ...
].filter(n => n.show !== false);
