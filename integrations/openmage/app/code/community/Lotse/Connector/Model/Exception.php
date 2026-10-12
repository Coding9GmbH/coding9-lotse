<?php
/**
 * API-Fehler mit HTTP-Status und stabilem Fehlercode (z. B. not_found, validation).
 */
class Lotse_Connector_Model_Exception extends Exception
{
    protected $status;
    protected $errorCode;
    protected $details;

    public function __construct($status, $errorCode, $message, array $details = [])
    {
        parent::__construct($message);
        $this->status = (int) $status;
        $this->errorCode = (string) $errorCode;
        $this->details = $details;
    }

    public function getStatus()
    {
        return $this->status;
    }

    public function getErrorCode()
    {
        return $this->errorCode;
    }

    public function getDetails()
    {
        return $this->details;
    }

    public static function notFound($message = 'Nicht gefunden')
    {
        return new self(404, 'not_found', $message);
    }

    public static function validation($message, array $details = [])
    {
        return new self(400, 'validation', $message, $details);
    }

    public static function conflict($message)
    {
        return new self(409, 'conflict', $message);
    }
}
