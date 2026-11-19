-- #566: optional copy-forward of inbound mail. When set, email() forwards each accepted
-- message to this Email Routing destination (a verified destination address) after the
-- inbound event is queued, so a mailbox keeps receiving a copy while its address moves
-- from forwarding to the worker. Additive: a nullable column.
ALTER TABLE email_domains ADD COLUMN forward_copy_to TEXT;
