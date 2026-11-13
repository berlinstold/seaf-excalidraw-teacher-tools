# Changelog

## 2.0.0

- Neu: Präsentationsmodus mit getrennter **Lehrendenansicht** und **Lernendenansicht** in zwei Tabs desselben Whiteboards
  - Tafel für Lernende einfrieren und aufdecken (Standbild, optional sanft überblendet)
  - Ansicht spiegeln (Verschieben/Zoomen live, passend zum Bildformat der Lernendenansicht) oder einmalig übertragen
  - Timer wird als reine Anzeige in die Lernendenansicht übertragen
  - Lernendenansicht ohne Bedienelemente, mit Vollbild nur für die Tafel und dezentem Statushinweis
  - Schutz: Neu geladene Lernendenansicht zeigt während des Einfrierens keinen verborgenen Stand
  - Tastenkürzel Alt+Shift+F (einfrieren/aufdecken), Alt+Shift+M (spiegeln), Alt+Shift+P (Panel)
- Neuer Präsentations-Button in der Excalidraw-Leiste neben dem Timer-Button

## 1.1.0

- Toolbar-Button übernimmt Größe, Rundung, Icon-Größe und Linienstärke automatisch vom benachbarten Original-Button
- Button vertikal zentriert, Original-Trennstrich von Excalidraw wird verwendet
- Alle Symbole im Overlay als SVG-Icons im Excalidraw-Stil (keine Emojis oder Sonderzeichen mehr)
- Ton-Schalter als Lautsprecher-Symbol
- Behoben: Overlay wurde beim manuellen Eintippen der Zeit sehr breit

## 1.0.0

- Erste Version: Countdown, Stoppuhr, Schnellwahl, +1 min, Zeiteingabe, Alarm, Schriftgrößen, Kompaktmodus, Hell/Dunkel, Tastenkürzel Alt+Shift+T
- Installer für Unraid/Docker (`install.sh`), findet die nginx-Konfiguration automatisch (auch außerhalb von `/shared`)
- Alternativ als Userscript nutzbar
