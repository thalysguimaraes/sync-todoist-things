#!/usr/bin/osascript

-- Read recently deleted tasks from Things (Trash)
-- Returns JSON array: [{"thingsId":"...","deletedAt":"ISO-8601"}, ...]
-- Note: Things does not expose deletion timestamps via AppleScript;
-- we return current timestamp for each, suitable as a best-effort marker.

on run
    set json_output to "["
    set first_item to true
    set now_iso to my current_iso8601()
    
    tell application "Things3"
        try
            set trashed_todos to to dos of list "Trash"
            repeat with aTodo in trashed_todos
                if not first_item then
                    set json_output to json_output & ","
                end if
                set first_item to false
                set json_output to json_output & "{\"thingsId\":\"" & (id of aTodo) & "\",\"deletedAt\":\"" & now_iso & "\"}"
            end repeat
        on error errMsg
            -- If Trash list not accessible, return empty array
        end try
    end tell
    
    set json_output to json_output & "]"
    return json_output
end run

on current_iso8601()
    set theDate to (current date)
    set y to year of theDate as integer
    set m to month of theDate as integer
    set d to day of theDate as integer
    set hh to hours of theDate as integer
    set mm to minutes of theDate as integer
    set ss to seconds of theDate as integer
    set tz to do shell script "date +%z"
    set sign to text 1 of tz
    set tzh to text 2 thru 3 of tz
    set tzm to text 4 thru 5 of tz
    set iso to (y as string) & "-" & my pad2(m) & "-" & my pad2(d) & "T" & my pad2(hh) & ":" & my pad2(mm) & ":" & my pad2(ss) & sign & tzh & ":" & tzm
    return iso
end current_iso8601

on pad2(n)
    set s to n as integer
    if s < 10 then
        return "0" & s
    else
        return s as string
    end if
end pad2
