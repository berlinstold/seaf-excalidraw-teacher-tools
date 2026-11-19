# Changelog

## 2.3.0 (in Arbeit)

- Neu: Leitfrage, Fragestellung und Hypothese
  - Drei markierte Tafel-Elemente; ihr Text erscheint dauerhaft oben links, auch in der Lernendenansicht
  - Element-Design: farbiger Reiter mit großer Überschrift über dem Eingabekasten
    (Leitfrage Blau, Fragestellung Mint `#e6fcf5`, Hypothese Violett)
  - Overlay im gleichen Stil, schmal gehalten, Reihenfolge Leitfrage, Fragestellung, Hypothese
  - Overlay nur für Elemente mit Text, die nicht selbst vollständig sichtbar sind
  - Elemente kommen automatisch in die Excalidraw-Bibliothek (bei jedem Laden geprüft, fehlende ergänzt, ältere
    Versionen ersetzt) und liegen als `library/leitfrage-fragestellung-hypothese.excalidrawlib` bei
  - Lehrendenansicht: weicht dem Eigenschaften-Panel aus, einklappbar, Klick springt zum Element
  - Eingefrorene Lernendenansicht zeigt den Stand vom Einfrieren
- Hinweis der Lernendenansicht sitzt jetzt unten rechts (oben links ist das Overlay)

## 2.2.0

- Neu: Stundenuhr in der Leiste (nur für Lehrende, nie in der Lernendenansicht)
  - Restzeit der Unterrichtsstunde minutengenau in Kurzform („23 min“), ab 5 Minuten Restzeit orange, beim Überziehen rot
  - Ausführliche Anzeige im Tooltip und im Fenster; bei schmaler Leiste automatisch Minimalform („23′“)
  - Einzel- oder Doppelstunde mit Pause; die Pause erscheint in der Leiste („Pause 3 min“), die aktuelle Stunde im Tooltip und im Fenster
  - Beginn minutengenau verschieben (−1/+1) oder als Uhrzeit eintippen
  - Läuft über Neuladen hinweg, verschwindet 30 Minuten nach Stundenende von selbst
  - Stunden- und Pausenlänge oben im Skript einstellbar (`LESSON_MINUTES`, `LESSON_BREAK_MINUTES`)
- Release-Workflow: Versionen mit Zusatz (z. B. `-dev`) lösen kein Release aus

## 2.1.0

- Timer bleibt in der Lernendenansicht sichtbar, wenn er in der Lehrendenansicht geschlossen wird; ein- und ausblenden über den Schalter im Präsentationspanel oder das neue Augen-Symbol im Timer
- Restzeit wird bei geschlossenem Timer klein neben dem Timer-Symbol in der Leiste angezeigt
- Neu: optionaler Titel über der Zeit (Vorlagen „Eigenarbeit/Partnerarbeit/Gruppenarbeit endet in“ oder eigener Text), auch in der Lernendenansicht
- Behoben: Timer sprang in der Lernendenansicht nach Schließen und erneutem Öffnen an eine falsche Position
- Hinweis der Lernendenansicht sitzt jetzt oben links auf der Tafel statt unten links bei den Zoom-Buttons; Bedienelemente werden in der Lernendenansicht vollständiger ausgeblendet

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
