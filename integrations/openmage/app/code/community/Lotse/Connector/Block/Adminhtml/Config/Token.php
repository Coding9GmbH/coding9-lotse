<?php
/**
 * Konfigurationsfeld „API-Token“: zeigt nur, ob ein Token gesetzt ist, und einen Button
 * „Token erzeugen“. Der neue Token wird per AJAX erzeugt und genau einmal angezeigt.
 */
class Lotse_Connector_Block_Adminhtml_Config_Token extends Mage_Adminhtml_Block_System_Config_Form_Field
{
    protected function _getElementHtml(Varien_Data_Form_Element_Abstract $element)
    {
        $hasToken = Mage::helper('lotse_connector')->getToken() !== '';
        $url = $this->getUrl('adminhtml/lotse_connector/generate');
        $status = $hasToken
            ? $this->__('Ein Token ist gesetzt (wird nicht angezeigt).')
            : $this->__('Noch kein Token gesetzt.');
        $label = $hasToken ? $this->__('Neuen Token erzeugen') : $this->__('Token erzeugen');
        $confirm = $this->__('Ein neuer Token ersetzt den bisherigen sofort. Lotse muss danach neu verbunden werden. Fortfahren?');
        $html = '<div id="lotse-token-status" style="margin-bottom:6px">' . $this->escapeHtml($status) . '</div>';
        $html .= '<button type="button" class="scalable" id="lotse-token-generate" onclick="lotseGenerateToken()"><span><span><span>'
            . $this->escapeHtml($label) . '</span></span></span></button>';
        $html .= '<div id="lotse-token-result" style="display:none;margin-top:8px">'
            . '<strong>' . $this->__('Neuer Token (nur jetzt sichtbar, bitte in Lotse eintragen):') . '</strong><br>'
            . '<input type="text" readonly="readonly" id="lotse-token-value" class="input-text" style="width:100%;font-family:monospace" onclick="this.select()">'
            . '</div>';
        $html .= '<script type="text/javascript">
function lotseGenerateToken() {
    if (!confirm(' . json_encode($confirm) . ')) { return; }
    var btn = $("lotse-token-generate"); btn.disabled = true;
    new Ajax.Request(' . json_encode($url) . ', {
        method: "post",
        parameters: { form_key: FORM_KEY },
        onSuccess: function (t) {
            btn.disabled = false;
            var r = {};
            try { r = t.responseText.evalJSON(); } catch (e) { alert("Antwort nicht lesbar"); return; }
            if (r.error) { alert(r.error); return; }
            $("lotse-token-value").value = r.token;
            $("lotse-token-result").show();
            $("lotse-token-status").update(' . json_encode($this->__('Ein Token ist gesetzt (wird nicht angezeigt).')) . ');
        },
        onFailure: function () { btn.disabled = false; alert("Token konnte nicht erzeugt werden."); }
    });
}
</script>';
        return $html;
    }
}
