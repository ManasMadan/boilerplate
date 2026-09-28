-- Runs once, when the Postgres volume is first created.
-- `app_test` is the integration-test database: tests migrate and truncate it freely
-- without touching your development data in `app`.
CREATE DATABASE app_test;
